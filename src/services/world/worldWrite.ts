import { Prisma, type PrismaClient } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";
import { syncWorldItemsAndEmbed } from "./itemSync.js";
import {
  buildActiveNameSet,
  type ChronologyRollupOptions,
  nextExtractionSeq,
  rollupChronology,
  stampRecency,
} from "./lifecycle.js";
import { applyDelta, type WorldCheckpoint, type WorldDelta } from "./merge.js";

const logger = createLogger("world:write");

/**
 * The ONLY sanctioned way to mutate a world's checkpoint.
 *
 * `applyDelta` is a pure function and `worldService.saveCheckpoint` is an unguarded
 * UPDATE; composing them in caller code produces a lost-update race:
 *
 *     Writer A            Writer B
 *     read v1
 *                         read v1
 *     merge → v2a
 *                         merge → v2b
 *     write v2a
 *                         write v2b     ← A's entities are gone
 *
 * This fails *silently* — the merge engine never deletes, so nothing errors and no tombstone is
 * written; entities just stop existing. With several agents writing concurrently (the entire point
 * of serving one brain over MCP) that is the normal case, not an edge case.
 *
 * Holding the row lock across the read and the write closes the window.
 */

const EMPTY_CHECKPOINT: WorldCheckpoint = {
  characters: [],
  locations: [],
  items: [],
  rules: [],
  plot_threads: [],
  chronology: [],
  knowledge: [],
  events: [],
};

/**
 * Max time a writer may hold the checkpoint row lock. A wedged transaction would otherwise block
 * every other writer for that world indefinitely; better to fail one write loudly.
 */
const WRITE_LOCK_TIMEOUT_MS = 10_000;

export interface ApplyDeltaOptions {
  /**
   * External anchor id for the audit snapshot row written inside the transaction.
   * Omit to skip snapshotting (the world's live checkpoint is still updated).
   */
  checkpointMessageId?: string;
  /**
   * Entity names considered "active" this pass, for recency stamping. Defaults to every name
   * mentioned by the delta, which is the right answer unless the caller knows better (e.g. the
   * characters present in a scene that the delta didn't happen to touch).
   */
  activeNames?: Iterable<string | undefined | null>;
  /** Overrides for the chronology rollup that keeps the checkpoint bounded. */
  chronologyRollup?: ChronologyRollupOptions;
  /**
   * Skip the post-commit item sync + embed. The sync is network-bound and best-effort; tests and
   * bulk backfills that will sync once at the end should skip it.
   */
  skipSync?: boolean;
}

/** Every entity name the delta touches — the default "active this pass" set. */
function namesFromDelta(delta: WorldDelta): string[] {
  return [
    ...(delta.add ?? []).map((e) => e?.name),
    ...(delta.update ?? []).map((e) => e?.name),
    ...(delta.new_memories ?? []).map((e) => e?.name),
    ...(delta.scene?.present_characters ?? []),
  ].filter((n): n is string => typeof n === "string" && n.trim().length > 0);
}

export interface ApplyDeltaResult {
  checkpoint: WorldCheckpoint;
  /** Extraction sequence this write was stamped with. */
  seq: number;
}

/**
 * Applies a delta to a world's checkpoint atomically: the read, the merge, and the write all
 * happen under `SELECT ... FOR UPDATE`, so concurrent writers serialize instead of clobbering.
 *
 * Deliberately takes a *delta*, not a checkpoint — accepting a whole checkpoint would let a caller
 * overwrite concurrent work no matter how the write is locked.
 *
 * The item sync + embedding pass runs AFTER the transaction commits. It is network-bound (an HTTP
 * call per entity to the embedding provider); holding a row lock across it would serialize every
 * writer for that world on provider latency. It is also idempotent and best-effort, so running it
 * outside the transaction costs nothing but a brief window where the checkpoint is ahead of the
 * relational projection.
 *
 * @throws if the world does not exist or is not owned by `userId`.
 */
export async function applyDeltaTransactional(
  db: PrismaClient,
  userId: string,
  worldId: string,
  delta: WorldDelta,
  opts: ApplyDeltaOptions = {},
): Promise<ApplyDeltaResult> {
  const result = await db.$transaction(async (tx) => {
    // Bound how long this writer can hold the lock. LOCAL → reverts on commit/rollback.
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${WRITE_LOCK_TIMEOUT_MS}`);

    // FOR UPDATE is the whole point: it blocks any other writer for this world until we commit,
    // so the checkpoint we merge onto is guaranteed to still be current when we write it back.
    const rows = await tx.$queryRaw<Array<{ id: string; userId: string; checkpoint: unknown }>>(
      Prisma.sql`SELECT id, "userId", checkpoint FROM worlds WHERE id = ${worldId} FOR UPDATE`,
    );

    const row = rows[0];
    if (!row) throw new Error(`World not found: ${worldId}`);
    // Ownership is checked inside the transaction, against the locked row — checking it before
    // the lock would race with a concurrent ownership change.
    if (row.userId !== userId) throw new Error(`World not found: ${worldId}`);

    const base = (row.checkpoint as WorldCheckpoint | null) ?? EMPTY_CHECKPOINT;
    const seq = nextExtractionSeq(base);

    const merged = applyDelta(base, delta);
    const activeNames = buildActiveNameSet(opts.activeNames ?? namesFromDelta(delta));
    const stamped = stampRecency(merged, base, activeNames, seq);
    const next = rollupChronology(stamped, opts.chronologyRollup);

    await tx.world.update({
      where: { id: worldId },
      data: { checkpoint: next as unknown as Prisma.InputJsonValue },
    });

    // Audit snapshot, written in the same transaction so it can never disagree with the live
    // checkpoint it claims to record.
    if (opts.checkpointMessageId) {
      await tx.worldCheckpoint.create({
        data: {
          worldId: worldId,
          messageId: opts.checkpointMessageId,
          data: next as unknown as Prisma.InputJsonValue,
          summary: typeof next.summary === "string" ? next.summary : null,
        },
      });
    }

    return { checkpoint: next, seq };
  });

  logger.info("Applied delta", {
    worldId,
    seq: result.seq,
    added: delta.add?.length ?? 0,
    updated: delta.update?.length ?? 0,
  });

  // Outside the transaction — see the doc comment. Best-effort by design: syncWorldItemsAndEmbed
  // swallows its own errors, and the checkpoint (the source of truth) is already committed.
  if (!opts.skipSync) {
    await syncWorldItemsAndEmbed(db, worldId, result.checkpoint, userId);
  }

  return result;
}
