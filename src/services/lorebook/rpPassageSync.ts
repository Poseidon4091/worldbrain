import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { mapWithConcurrency } from "../../utils/concurrency.js";
import { createLogger } from "../../utils/logger.js";
import { type EmbeddingRouterType, embedText, storeLorebookEmbedding } from "../embedding/index.js";

const logger = createLogger("lorebook:rpPassageSync");

/** Target character count per passage chunk. Splits at message boundaries. */
const CHUNK_SIZE = 1_500;

/**
 * Max rp_passage rows to retain per lorebook. Passages accumulate on every extraction
 * and were previously never pruned — growing without bound for the lifetime of a chat.
 * At ~1,500 chars/chunk this cap keeps roughly the most recent ~600k chars of verbatim
 * RP available for retrieval. Older scenes are not lost from the story: the Librarian's
 * chronology/summary in the checkpoint is the durable long-term memory layer, so pruning
 * the oldest verbatim chunks trims redundant storage without erasing narrative history.
 * Deliberately generous — only very long-running chats ever reach it.
 */
const RP_PASSAGE_RETENTION = 400;

/**
 * Deletes the oldest rp_passage rows for a lorebook beyond RP_PASSAGE_RETENTION,
 * keeping the most recent ones. Best-effort — never throws.
 */
async function pruneOldRpPassages(db: PrismaClient, lorebookId: string): Promise<void> {
  try {
    const countRows = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "lorebook_items"
      WHERE "lorebookId" = ${lorebookId} AND "type" = 'rp_passage'
    `);
    const total = Number(countRows[0]?.count ?? 0n);
    if (total <= RP_PASSAGE_RETENTION) return;

    const deleted = await db.$executeRaw(Prisma.sql`
      DELETE FROM "lorebook_items"
      WHERE "type" = 'rp_passage'
        AND "lorebookId" = ${lorebookId}
        AND "id" NOT IN (
          SELECT "id" FROM "lorebook_items"
          WHERE "type" = 'rp_passage' AND "lorebookId" = ${lorebookId}
          ORDER BY "createdAt" DESC
          LIMIT ${RP_PASSAGE_RETENTION}
        )
    `);
    logger.info("Pruned old RP passages", { lorebookId, deleted, retained: RP_PASSAGE_RETENTION });
  } catch (err) {
    logger.warn("RP passage prune failed — skipping", { lorebookId, err });
  }
}

/**
 * A conversation turn to be chunked into passages. Supplied BY THE CALLER — worldbrain has no
 * Message table of its own. The chat/transcript store lives in whatever app or connector feeds
 * this engine, so the turns to index are passed in rather than queried out of a coupled schema.
 */
export interface RpMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

/**
 * Groups sequential messages into text chunks of ~CHUNK_SIZE chars.
 * Each chunk's key is `rp-<full message id>` of its first message — the full UUID, not a
 * truncated prefix, so distinct chunks can never collide under the ON CONFLICT DO NOTHING
 * insert (which would silently drop a passage). The key is stable, so re-runs stay idempotent.
 */
function buildChunks(messages: RpMessage[]): Array<{ key: string; text: string }> {
  const chunks: Array<{ key: string; text: string }> = [];
  let currentText = "";
  let chunkKey = "";

  for (const msg of messages) {
    const label = msg.role === "user" ? "USER" : "STORY";
    const line = `${label}: ${msg.content.replace(/\u0000/g, "").trim()}\n\n`;

    if (currentText.length > 0 && currentText.length + line.length > CHUNK_SIZE) {
      chunks.push({ key: chunkKey, text: currentText.trimEnd() });
      currentText = line;
      chunkKey = `rp-${msg.id}`;
    } else {
      if (currentText.length === 0) {
        chunkKey = `rp-${msg.id}`;
      }
      currentText += line;
    }
  }

  if (currentText.trim() && chunkKey) {
    chunks.push({ key: chunkKey, text: currentText.trimEnd() });
  }

  return chunks;
}

/**
 * Returns the external message id of the most recent checkpoint BEFORE the one just written —
 * the watermark for "which turns have already been chunked into passages".
 *
 * worldbrain stores only the external anchor id, not the message itself, so the caller resolves
 * this id to a timestamp (or an index) in whatever transcript store it owns and passes the turns
 * after that point to `syncRpPassages`.
 *
 * @param currentCheckpointMessageId  The messageId of the checkpoint just created.
 * @returns The previous checkpoint's messageId, or null if this is the first checkpoint.
 */
export async function getPassageWatermark(
  db: PrismaClient,
  lorebookId: string,
  currentCheckpointMessageId: string,
): Promise<string | null> {
  const previousCheckpoint = await db.lorebookCheckpoint.findFirst({
    where: { lorebookId, messageId: { not: currentCheckpointMessageId } },
    orderBy: { createdAt: "desc" },
    select: { messageId: true },
  });
  return previousCheckpoint?.messageId ?? null;
}

/**
 * Chunks conversation turns into ~CHUNK_SIZE passages and stores them as `rp_passage`
 * lorebook_items. Safe to call multiple times — the `ON CONFLICT DO NOTHING` insert means
 * previously-chunked passages are skipped and only new ones are embedded, so an over-broad
 * `messages` window is harmless (just wasted work, never duplicates).
 *
 * Fires after a successful extraction pass. Use `getPassageWatermark` to determine which
 * turns are new.
 *
 * @param messages  The turns to chunk, in chronological order. Caller-supplied — see RpMessage.
 */
export async function syncRpPassages(
  db: PrismaClient,
  lorebookId: string,
  userId: string,
  messages: RpMessage[],
): Promise<void> {
  try {
    if (messages.length === 0) return;

    const chunks = buildChunks(messages);
    if (chunks.length === 0) return;

    logger.info("Syncing RP passages", { lorebookId, chunkCount: chunks.length });

    const settings = await db.settings.findUnique({ where: { userId } });
    const embeddingEnabled = settings?.embeddingEnabled ?? false;
    const router = (settings?.embeddingRouter as EmbeddingRouterType) ?? "openrouter";
    const model = settings?.embeddingModel ?? undefined;

    // Collect newly-inserted passages, then embed them post-loop through a bounded pool
    // instead of firing an unbounded embedText call per chunk.
    let newCount = 0;
    const embedJobs: Array<{ itemId: string; text: string; key: string }> = [];

    for (const chunk of chunks) {
      // ON CONFLICT DO NOTHING — idempotent; skips any chunk already stored
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "lorebook_items" (
          "id", "lorebookId", "key", "type", "content", "importanceScore", "createdAt", "updatedAt"
        )
        VALUES (
          ${randomUUID()}, ${lorebookId}, ${chunk.key}, ${"rp_passage"}, ${chunk.text}, ${1}, NOW(), NOW()
        )
        ON CONFLICT ("lorebookId", "key") DO NOTHING
        RETURNING "id"
      `);

      const itemId = rows[0]?.id;
      if (!itemId) continue; // already existed, skip re-embedding

      newCount++;
      if (embeddingEnabled) embedJobs.push({ itemId, text: chunk.text, key: chunk.key });
    }

    logger.info("RP passage sync complete", { lorebookId, newChunks: newCount, total: chunks.length });

    if (embedJobs.length > 0) {
      const EMBED_CONCURRENCY = 5;
      void mapWithConcurrency(embedJobs, EMBED_CONCURRENCY, async (job) => {
        try {
          const result = await embedText(job.text, router, model, "document");
          await storeLorebookEmbedding(db, job.itemId, result.embedding, result.model);
        } catch (err) {
          logger.warn("Failed to embed RP passage", { itemId: job.itemId, key: job.key, err });
        }
      });
    }

    // Trim ancient verbatim passages beyond the retention cap. Only meaningful once new
    // chunks were actually added, so skip the query when nothing changed this turn.
    if (newCount > 0) await pruneOldRpPassages(db, lorebookId);
  } catch (err) {
    // Never propagate — passage sync is best-effort
    logger.error("RP passage sync failed", { lorebookId, err });
  }
}
