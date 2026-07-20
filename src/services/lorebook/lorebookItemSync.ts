import { EMBEDDING_CROSS_LINK_MAX_CHARS, EMBEDDING_FIXED_CONTENT_MAX_CHARS } from "../../config/limits.js";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { mapWithConcurrency } from "../../utils/concurrency.js";
import { createLogger } from "../../utils/logger.js";
import { type EmbeddingRouterType, embedText, storeLorebookEmbedding } from "../embedding/index.js";
import { phraseAppearsInText } from "./lorebookDciSearch.js";

const logger = createLogger("lorebook:sync");

async function upsertLorebookItem(
  db: PrismaClient,
  lorebookId: string,
  key: string,
  type: string,
  content: string,
  importanceScore: number,
): Promise<string> {
  // Prisma's model upsert is currently tripping Postgres binary bind errors on lorebook_items.
  // Using a direct SQL upsert avoids that protocol path.
  //
  // importanceScore is SEEDED on insert but deliberately NOT overwritten on conflict.
  // It is a persistent ranking signal owned by retrievalFeedback.ts, which nudges it
  // ±0.05 per turn. Previously this upsert reset it to the checkpoint's discrete base
  // (1/2/3) every extraction, wiping every feedback nudge before it could accumulate.
  // Core-floor prompt injection reads `importance` from the content JSON (updated here),
  // not this column, so preserving the learned score does not affect which entities are
  // force-injected — only their vector-search ranking weight.
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "lorebook_items" (
      "id",
      "lorebookId",
      "key",
      "type",
      "content",
      "importanceScore",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${randomUUID()},
      ${lorebookId},
      ${key},
      ${type},
      ${content},
      ${importanceScore},
      NOW(),
      NOW()
    )
    ON CONFLICT ("lorebookId", "key")
    DO UPDATE SET
      "type" = EXCLUDED."type",
      "content" = EXCLUDED."content",
      "updatedAt" = NOW()
    RETURNING "id"
  `);

  if (!rows[0]?.id) {
    throw new Error(`Lorebook item upsert did not return an id for key "${key}"`);
  }

  return rows[0].id;
}

/**
 * Synchronizes a merged Lorebook checkpoint (JSON) into relational LorebookItem models
 * in the database, and asynchronously generates/updates their vector embeddings if enabled.
 */
export async function syncLorebookItemsAndEmbed(db: PrismaClient, lorebookId: string, checkpoint: any, userId: string) {
  try {
    const settings = await db.settings.findUnique({ where: { userId } });
    const embeddingEnabled = settings?.embeddingEnabled ?? false;
    const router = (settings?.embeddingRouter as EmbeddingRouterType) ?? "openrouter";
    const model = settings?.embeddingModel ?? undefined;

    const entities: any[] = [
      ...(checkpoint.characters || []).map((e: any) => ({ ...e, type: "character" })),
      ...(checkpoint.locations || []).map((e: any) => ({ ...e, type: "location" })),
      ...(checkpoint.items || []).map((e: any) => ({ ...e, type: "item" })),
      ...(checkpoint.rules || []).map((e: any) => ({ ...e, type: "rule" })),
      ...(checkpoint.knowledge || []).map((e: any) => ({ ...e, type: "knowledge" })),
      ...(checkpoint.events || []).map((e: any) => ({ ...e, type: "event" })),
      // World laws as embedded items — stored as strings in the checkpoint,
      // so we synthesize a name from the text itself for a stable key.
      ...(checkpoint.world_laws || [])
        .filter((w: any) => typeof w === "string" && w.trim())
        .map((w: string) => ({
          name: `[Law] ${w.substring(0, 80)}`,
          blurb: w,
          type: "world_law",
        })),
      // Chronology entries as first-class embedded items so timeline queries
      // ("when did X happen", "what was the last big event") can be RAG-retrieved.
      ...(checkpoint.chronology || [])
        .filter((c: any) => c.summary)
        .map((c: any) => ({
          name: c.timestamp ? `[${c.timestamp}] ${c.summary.substring(0, 80)}` : c.summary.substring(0, 80),
          blurb: [c.summary, ...(c.key_events || [])].join(" — "),
          type: "chronology",
        })),
    ];

    if (entities.length === 0) return;

    logger.info(`Starting LorebookItem sync`, { lorebookId, count: entities.length, embeddingEnabled });

    // Track which item keys are active so we can clean up stale ones
    const activeKeys = new Set<string>();
    let hadSyncErrors = false;

    // Embedding jobs are collected during the upsert loop and run afterwards through a
    // bounded concurrency pool. Previously each entity fired its embedText call immediately
    // and unbounded — a large checkpoint (dozens of entities) launched that many simultaneous
    // requests, easily tripping embedding-provider rate limits.
    const embedJobs: Array<{ itemId: string; embedContent: string; key: string }> = [];

    for (const entity of entities) {
      if (!entity.name || !entity.blurb) continue;

      const key = String(entity.name).trim();
      activeKeys.add(key);

      const blurb = String(entity.blurb).replace(/\u0000/g, "");
      const tags = (entity.tags || []).join(", ");

      // Text used for semantic embedding — includes fixedContent so the canonical
      // character description anchors the vector, not just the evolving blurb.

      // Cross-link: fold related events and chronology into the entity's embedding text
      // so queries like "what happened at the Ministry" or "what did Harry do at the battle"
      // can surface the right entity even when the query doesn't match its blurb directly.
      //
      // Word-boundary matching (not raw substring) so entity "Ron" doesn't cross-link on
      // "environment" etc. when folding related beats into the embedding text.
      // Chronology entries that mention this entity by name
      const relatedChron = (checkpoint.chronology ?? [])
        .filter((c: any) => c.summary && phraseAppearsInText(key, c.summary))
        .map((c: any) => c.summary as string)
        .slice(0, 5)
        .join(" / ");

      // For locations: also fold in named events that occurred there
      const relatedEvents =
        entity.type === "location"
          ? (checkpoint.events ?? [])
              .filter(
                (e: any) =>
                  (e.blurb && phraseAppearsInText(key, e.blurb)) || (e.name && phraseAppearsInText(key, e.name)),
              )
              .map((e: any) => `${e.name}: ${e.blurb}`)
              .slice(0, 4)
              .join(" / ")
          : "";

      // For events: anchor to the location(s) and participants mentioned in the blurb
      const eventContext =
        entity.type === "event"
          ? (() => {
              const loc = (checkpoint.locations ?? []).find(
                (l: any) => l.name && phraseAppearsInText(l.name, blurb),
              );
              const chars = (checkpoint.characters ?? [])
                .filter((c: any) => c.name && phraseAppearsInText(c.name, blurb))
                .map((c: any) => c.name as string)
                .slice(0, 5);
              return [loc ? `Location: ${loc.name}` : null, chars.length ? `Participants: ${chars.join(", ")}` : null]
                .filter(Boolean)
                .join("\n");
            })()
          : "";

      const crossLinkParts = [relatedChron, relatedEvents, eventContext].filter(Boolean).join("\n");

      const embedContent = [
        `${key}\n${blurb}`,
        tags ? `Tags: ${tags}` : null,
        entity.fixedContent ? `Core: ${String(entity.fixedContent).substring(0, EMBEDDING_FIXED_CONTENT_MAX_CHARS)}` : null,
        crossLinkParts ? crossLinkParts.substring(0, EMBEDDING_CROSS_LINK_MAX_CHARS) : null,
      ]
        .filter(Boolean)
        .join("\n");

      // JSON stored in the content column — parsed by buildPrompt.ts to rehydrate
      // RAG-retrieved entities back into the prompt. Must be valid JSON.
      const storedContent = JSON.stringify({
        name: key,
        blurb,
        tags: entity.tags ?? [],
        traits: entity.traits ?? [],
        relationships: entity.relationships ?? {},
        importance: entity.importance,
        status: entity.status,
        fixedContent: entity.fixedContent,
      });

      let importanceNum = 2; // middle = 2, minor = 1, core = 3
      if (entity.importance === "core") importanceNum = 3;
      if (entity.importance === "minor") importanceNum = 1;

      try {
        const itemId = await upsertLorebookItem(db, lorebookId, key, entity.type, storedContent, importanceNum);

        // Queue embedding (use embedContent plain text, not storedContent JSON). Runs
        // post-loop through a bounded pool rather than firing immediately per entity.
        if (embeddingEnabled) {
          embedJobs.push({ itemId, embedContent, key });
        }
      } catch (err) {
        hadSyncErrors = true;
        logger.error("Failed to upsert LorebookItem", {
          lorebookId,
          key,
          type: entity.type,
          importanceScore: importanceNum,
          contentLength: storedContent.length,
          err,
        });
      }
    }

    // Kick off embeddings as a detached background batch with bounded concurrency, so the
    // sync itself stays non-blocking but never fans out more than EMBED_CONCURRENCY requests.
    if (embedJobs.length > 0) {
      const EMBED_CONCURRENCY = 5;
      void mapWithConcurrency(embedJobs, EMBED_CONCURRENCY, async (job) => {
        try {
          const result = await embedText(job.embedContent, router, model, "document");
          await storeLorebookEmbedding(db, job.itemId, result.embedding, result.model);
        } catch (err) {
          logger.warn("Failed to embed LorebookItem", { itemId: job.itemId, key: job.key, err });
        }
      });
    }

    if (hadSyncErrors) {
      logger.warn("Skipping LorebookItem deletion because sync had upsert errors", { lorebookId });
      return;
    }

    // SAFETY CHECK: If we have 0 active keys but the database already had items,
    // it's VERY likely the checkpoint passed in was corrupted or stripped (e.g. by a RAG bug).
    // We skip deletion in this case to protect the user's data.
    if (activeKeys.size === 0) {
      const existingCount = await db.lorebookItem.count({ where: { lorebookId } });
      if (existingCount > 0) {
        logger.warn(
          "Sync encountered 0 entities in checkpoint but items exist in DB. Skipping deletion to prevent data loss.",
          {
            lorebookId,
          },
        );
        return;
      }
    }

    // Optional: Soft-delete or hard-delete items that no longer exist in the checkpoint.
    // Passage types (rp_passage, canon_passage, compendium) are managed independently
    // and must never be deleted by checkpoint sync.
    const itemsToDelete = await db.lorebookItem.findMany({
      where: {
        lorebookId,
        key: { notIn: Array.from(activeKeys) },
        type: { notIn: ["rp_passage", "canon_passage", "compendium"] },
      },
    });

    if (itemsToDelete.length > 0) {
      await db.lorebookItem.deleteMany({
        where: { id: { in: itemsToDelete.map((i: any) => i.id) } },
      });
      logger.info(`Deleted stale LorebookItems during sync`, { count: itemsToDelete.length });
    }
  } catch (err) {
    logger.error("Failed to sync and embed LorebookItems", { lorebookId, err });
  }
}
