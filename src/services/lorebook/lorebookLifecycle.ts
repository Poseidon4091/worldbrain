import { normalizeName } from "./lorebookMerge.js";

/**
 * Bounded-memory lifecycle for lorebook checkpoints.
 *
 * Phase 2a — recency tracking. This module only RECORDS activity; it does not change
 * what gets injected or dropped. Later phases (chronology rollup, entity dormancy) read
 * the `lastSeenTurn` / `_extractionSeq` values it writes to decide what has gone cold.
 */

const ENTITY_ARRAYS = ["characters", "locations", "items", "knowledge", "events"] as const;

/**
 * Normalize a set of entity names for recency comparison. Mirrors the normalization used
 * when stamping merged entities so callers and this module agree on identity.
 */
export function buildActiveNameSet(names: Iterable<string | undefined | null>): Set<string> {
  const set = new Set<string>();
  for (const n of names) {
    const norm = normalizeName(n ?? undefined);
    if (norm) set.add(norm);
  }
  return set;
}

/**
 * Records recency on a freshly-merged checkpoint:
 *   - bumps `_extractionSeq` to `seq`
 *   - stamps `lastSeenTurn = seq` on every entity active this turn (name in `activeNames`)
 *   - preserves the prior `lastSeenTurn` for every other entity
 *
 * The prior stamp is recovered from the pre-merge `base` checkpoint by normalized name,
 * because applyLorebookDelta reconstructs entities and may not carry `lastSeenTurn` through.
 * Entities that were never stamped are backfilled to the current seq (a grace baseline) so
 * every entity carries recency going forward and can eventually be assessed for dormancy.
 *
 * Pure: returns a new checkpoint object; does not mutate `merged` or `base`.
 */
export function stampRecency<T extends Record<string, any>>(
  merged: T,
  base: Record<string, any> | null | undefined,
  activeNames: Set<string>,
  seq: number,
): T {
  // Prior stamps by normalized name, taken from the pre-merge base.
  const priorByName = new Map<string, number>();
  for (const arr of ENTITY_ARRAYS) {
    for (const e of (base?.[arr] as any[]) ?? []) {
      const norm = normalizeName(e?.name);
      const prior = typeof e?.lastSeenTurn === "number" ? e.lastSeenTurn : undefined;
      if (norm && prior !== undefined) {
        priorByName.set(norm, Math.max(priorByName.get(norm) ?? Number.NEGATIVE_INFINITY, prior));
      }
    }
  }

  const out: any = { ...merged, _extractionSeq: seq };
  for (const arr of ENTITY_ARRAYS) {
    if (!Array.isArray(merged[arr])) continue;
    out[arr] = (merged[arr] as any[]).map((e) => {
      const norm = normalizeName(e?.name);
      if (norm && activeNames.has(norm)) return { ...e, lastSeenTurn: seq };
      // Not active this turn — keep whatever stamp survived the merge, else recover from base.
      // If it has never been stamped (pre-lifecycle entity), backfill to the current seq so it
      // gets a grace baseline: it isn't treated as dormant now, but becomes eligible once it
      // stays unmentioned for the dormancy window. Without this baseline a never-mentioned
      // entity would have no recency and could never be demoted.
      const carried = typeof e?.lastSeenTurn === "number" ? e.lastSeenTurn : norm ? priorByName.get(norm) : undefined;
      return { ...e, lastSeenTurn: carried ?? seq };
    });
  }
  return out as T;
}

/** Next extraction sequence for a checkpoint (1 on the first pass). */
export function nextExtractionSeq(checkpoint: Record<string, any> | null | undefined): number {
  const current = typeof checkpoint?._extractionSeq === "number" ? checkpoint._extractionSeq : 0;
  return current + 1;
}

export interface ChronologyRollupOptions {
  /** Start rolling up once the active chronology exceeds this many entries. */
  softCap?: number;
  /** Number of most-recent entries to retain in the active array after a rollup. */
  keep?: number;
  /** Max length of the rolling archive breadcrumb; oldest text is dropped past this. */
  maxArchiveChars?: number;
}

/**
 * Phase 2b — chronology rollup. Keeps the active `chronology` array bounded so a long chat
 * doesn't grow the checkpoint without limit.
 *
 * When the array exceeds `softCap`, the oldest entries (all but the most recent `keep`) are
 * compressed into a compact breadcrumb appended to `chronology_archive`, then dropped from the
 * active array. No detail is lost: those beats are still embedded as chronology lorebook_items
 * and remain retrievable via RAG/DCI. The archive itself is length-bounded — once it exceeds
 * `maxArchiveChars`, its oldest (leading) text is trimmed, so it can't grow unbounded either.
 *
 * Pure: returns a new checkpoint; does not mutate the input. No-op when under the cap.
 */
export function rollupChronology<T extends Record<string, any>>(
  checkpoint: T,
  opts: ChronologyRollupOptions = {},
): T {
  const softCap = opts.softCap ?? 60;
  const keep = opts.keep ?? 40;
  const maxArchiveChars = opts.maxArchiveChars ?? 4000;

  const chron = checkpoint?.chronology;
  if (!Array.isArray(chron) || chron.length <= softCap) return checkpoint;

  const overflow = chron.slice(0, chron.length - keep); // oldest → archive
  const retained = chron.slice(chron.length - keep); // most-recent → stay active

  const digestParts = overflow
    .map((e: any) => {
      const ts = e?.timestamp ? `[${e.timestamp}] ` : "";
      const summary = typeof e?.summary === "string" ? e.summary.trim() : "";
      return summary ? `${ts}${summary}` : "";
    })
    .filter(Boolean);

  const priorArchive = typeof checkpoint.chronology_archive === "string" ? checkpoint.chronology_archive : "";
  let archive = [priorArchive, ...digestParts].filter(Boolean).join(" · ");

  // Bound the breadcrumb: drop the oldest (leading) text once over the cap.
  if (archive.length > maxArchiveChars) {
    archive = `…${archive.slice(archive.length - maxArchiveChars)}`;
  }

  return { ...checkpoint, chronology: retained, chronology_archive: archive };
}

/**
 * Default number of extraction passes without a mention before a core entity is considered
 * dormant. Extraction cadence is NOT fixed — it fires on a turn threshold OR a token delta,
 * and on token-heavy roleplays (large messages) it fires roughly every turn. So a pass ≈ 1 turn
 * in the worst case; a threshold of 20 keeps a recently-relevant character in the core floor
 * across a natural lull, and only demotes genuinely long-absent ones. Deliberately conservative:
 * demotion only affects unconditional injection, and DCI resurfaces the entity the instant its
 * name reappears.
 */
export const DEFAULT_DORMANCY_THRESHOLD = 20;

/**
 * Phase 2c — dormancy. True when an entity has gone cold: it has a recency stamp and hasn't
 * been active for at least `threshold` extraction passes. Unstamped entities are treated as
 * NOT dormant (grace) — stampRecency backfills a baseline, so this only matters transiently.
 */
export function isEntityDormant(
  entity: { lastSeenTurn?: number } | null | undefined,
  currentSeq: number,
  threshold: number = DEFAULT_DORMANCY_THRESHOLD,
): boolean {
  const seen = entity?.lastSeenTurn;
  if (typeof seen !== "number") return false;
  return currentSeq - seen >= threshold;
}

/**
 * Selects which core-importance entities get unconditionally injected (the "core floor"),
 * recency-aware:
 *   1. drop entities that have gone dormant (cold) — they fall to RAG-only and DCI resurfaces
 *      them on mention,
 *   2. of the rest, prefer the most-recently-active when a `cap` is applied.
 *
 * This replaces the old arbitrary insertion-order slice: under pressure (more core entities
 * than the cap) the coldest drop instead of whichever happened to be added first. With `cap`
 * omitted it just filters dormant (used for the uncapped location/item/event/knowledge floors).
 *
 * Pure. Non-core entities should not be passed here — this operates on an already core-filtered list.
 */
export function selectCoreFloor<T extends { lastSeenTurn?: number }>(
  coreEntities: T[],
  currentSeq: number,
  opts: { cap?: number; threshold?: number } = {},
): T[] {
  const threshold = opts.threshold ?? DEFAULT_DORMANCY_THRESHOLD;
  const live = coreEntities.filter((e) => !isEntityDormant(e, currentSeq, threshold));
  if (opts.cap === undefined || live.length <= opts.cap) return live;
  // Over the cap: keep the most-recently-active. Treat unstamped as fresh (currentSeq) so a
  // brand-new entity isn't deprioritized during the brief pre-backfill window.
  return [...live]
    .sort((a, b) => (b.lastSeenTurn ?? currentSeq) - (a.lastSeenTurn ?? currentSeq))
    .slice(0, opts.cap);
}
