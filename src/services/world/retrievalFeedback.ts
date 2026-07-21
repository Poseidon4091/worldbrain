import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("world:retrievalFeedback");

// How much to nudge importanceScore per feedback signal. Small deltas prevent
// over-tuning on noisy turns. Score is clamped to [1.0, 3.0].
const BOOST_DELTA = 0.05;
const DECAY_DELTA = 0.05;
const SCORE_MIN = 1.0;
const SCORE_MAX = 3.0;

/**
 * Adjusts importanceScore on world items based on retrieval vs Director outcome.
 *
 * - Retrieved AND Director-spotlighted  → small boost (entity is relevant and the model agrees)
 * - Retrieved AND Director-ignored      → small decay (entity was fetched but deemed irrelevant)
 *
 * Entities not retrieved are unaffected — absence of retrieval is not a signal.
 * Runs fire-and-forget after extraction. Never throws — failures are logged and swallowed.
 */
export async function applyRetrievalFeedback(
  db: PrismaClient,
  worldId: string,
  retrievalAudit:
    | {
        worldHits?: Array<{ worldId: string; key: string; similarity: number }>;
      }
    | undefined,
  directorEntities: Array<{ key: string; relevance?: number; action?: string }> | undefined,
): Promise<void> {
  if (!retrievalAudit?.worldHits?.length || !directorEntities?.length) return;

  try {
    // Only consider hits from the story world (not referenced worlds)
    const hits = retrievalAudit.worldHits.filter((h) => h.worldId === worldId);
    if (hits.length === 0) return;

    const directorMap = new Map(directorEntities.map((e) => [e.key, e]));

    const boostKeys: string[] = [];
    const decayKeys: string[] = [];

    for (const hit of hits) {
      const signal = directorMap.get(hit.key);
      if (!signal) continue; // No Director opinion — skip

      const isSpotlighted = signal.action === "spotlight" || (signal.relevance != null && signal.relevance >= 0.8);
      const isIgnored = signal.action === "ignore" || (signal.relevance != null && signal.relevance < 0.2);

      if (isSpotlighted) boostKeys.push(hit.key);
      else if (isIgnored) decayKeys.push(hit.key);
    }

    if (boostKeys.length === 0 && decayKeys.length === 0) return;

    // Fetch current scores in one query
    const items = await db.worldItem.findMany({
      where: {
        worldId,
        key: { in: [...boostKeys, ...decayKeys] },
      },
      select: { id: true, key: true, importanceScore: true },
    });

    const updates = items.map((item) => {
      const isBoost = boostKeys.includes(item.key);
      const delta = isBoost ? BOOST_DELTA : -DECAY_DELTA;
      const newScore = Math.min(SCORE_MAX, Math.max(SCORE_MIN, (item.importanceScore ?? 2) + delta));
      return db.worldItem.update({
        where: { id: item.id },
        data: { importanceScore: newScore },
      });
    });

    await Promise.all(updates);

    logger.debug("Retrieval feedback applied", {
      worldId,
      boosted: boostKeys.length,
      decayed: decayKeys.length,
    });
  } catch (err) {
    logger.warn("Retrieval feedback failed — skipping", { worldId, err });
  }
}
