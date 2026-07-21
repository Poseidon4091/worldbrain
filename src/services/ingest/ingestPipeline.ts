import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";
import { extractDelta } from "../intelligence/extraction.js";
import type { RouterType } from "../llm/routerDispatch.js";
import type { WorldCheckpoint, WorldDelta } from "../world/merge.js";
import { applyDeltaTransactional } from "../world/worldWrite.js";
import type { IngestDocument } from "./types.js";

const logger = createLogger("ingest:pipeline");

/**
 * Chunk size for a single extraction pass. Large documents are split because extraction quality
 * degrades badly when a model is asked to summarise 50k characters in one shot — it produces a
 * thin, generic delta and drops most of the specifics, which are the whole point.
 */
const CHUNK_CHARS = 12_000;

/** Cap on chunks per document, so one enormous file can't monopolise a sync pass. */
const MAX_CHUNKS = 12;

export interface IngestConfig {
  llmRouter: string;
  llmModel: string;
}

export interface IngestResult {
  ingested: number;
  skipped: number;
  failed: number;
}

/**
 * Splits on paragraph boundaries where possible, so a chunk doesn't end mid-sentence and strand
 * the context an extraction needs to make sense of it.
 *
 * Exported for tests: the fallback path for an unsplittable paragraph is easy to get wrong, and
 * getting it wrong means emitting an oversized chunk that degrades extraction quality silently.
 */
export function chunk(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n/);
  let current = "";

  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > CHUNK_CHARS) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
    // A single paragraph longer than the chunk size (minified data, one giant line) can't be
    // split on boundaries, so fall back to a hard cut rather than emitting an oversized chunk.
    while (current.length > CHUNK_CHARS) {
      chunks.push(current.slice(0, CHUNK_CHARS));
      current = current.slice(CHUNK_CHARS);
    }
  }
  if (current.trim()) chunks.push(current);

  return chunks.slice(0, MAX_CHUNKS);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Ingests one document into a book: extract a delta per chunk, merge each through the
 * transactional write path.
 *
 * Chunks are merged sequentially, never in parallel. Concurrent merges of the same book would
 * serialize on the row lock anyway, and each chunk's extraction benefits from seeing the
 * checkpoint the previous chunk produced — so it updates entities instead of re-adding them.
 */
export async function ingestDocument(
  db: PrismaClient,
  userId: string,
  worldId: string,
  doc: IngestDocument,
  config: IngestConfig,
): Promise<void> {
  const chunks = chunk(doc.content);
  logger.info("Ingesting document", { externalId: doc.externalId, chunks: chunks.length });

  for (const [i, text] of chunks.entries()) {
    const world = await db.world.findUnique({ where: { id: worldId }, select: { checkpoint: true } });
    const cp = (world?.checkpoint as WorldCheckpoint | null) ?? ({} as WorldCheckpoint);

    const extraction = await extractDelta({
      router: config.llmRouter as RouterType,
      model: config.llmModel,
      conversation: text,
      currentWorld: cp,
      tags: [],
    });

    if (!extraction?.world) {
      logger.warn("Extraction produced nothing", { externalId: doc.externalId, chunk: i });
      continue;
    }

    const lore = extraction.world;
    const delta: WorldDelta = {
      add: lore.add ?? [],
      update: lore.update ?? [],
      new_rules: lore.new_rules ?? [],
      new_plot_threads: lore.new_plot_threads ?? [],
      atmosphere: lore.atmosphere,
      world_laws: lore.world_laws ?? [],
      narrative_summary: lore.narrative_summary,
      chronology_entries: extraction.chronology ?? [],
    };

    await applyDeltaTransactional(db, userId, worldId, delta);
  }
}

/**
 * Runs a batch of documents through dedupe → ingest → ledger update.
 *
 * Dedupe is by content hash, not by presence: a re-poll of an unchanged file must be free, or
 * every sync tick re-extracts the whole corpus and bills for it. A changed file re-ingests in
 * full, and the merge engine reconciles it against what is already there.
 */
export async function ingestDocuments(
  db: PrismaClient,
  userId: string,
  worldId: string,
  sourceId: string,
  docs: IngestDocument[],
  config: IngestConfig,
): Promise<IngestResult> {
  const result: IngestResult = { ingested: 0, skipped: 0, failed: 0 };

  for (const doc of docs) {
    const hash = hashContent(doc.content);

    const existing = await db.sourceDocument.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: doc.externalId } },
      select: { contentHash: true },
    });

    if (existing?.contentHash === hash) {
      result.skipped++;
      continue;
    }

    try {
      await ingestDocument(db, userId, worldId, doc, config);

      // Ledger is written only AFTER a successful ingest. Writing it first would mark a document
      // as done even when extraction failed, and it would never be retried.
      await db.sourceDocument.upsert({
        where: { sourceId_externalId: { sourceId, externalId: doc.externalId } },
        update: { contentHash: hash, ingestedAt: new Date() },
        create: { sourceId, externalId: doc.externalId, contentHash: hash },
      });

      result.ingested++;
    } catch (err) {
      // One bad document must not abort the batch; it retries on the next pass.
      logger.error("Document ingest failed", { externalId: doc.externalId, err });
      result.failed++;
    }
  }

  return result;
}
