import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDeltaTransactional } from "./worldWrite.js";
import type { LorebookDelta } from "./lorebookMerge.js";

/**
 * Concurrency tests for the transactional write path.
 *
 * These need a REAL Postgres — the whole point is that `SELECT ... FOR UPDATE` serializes two
 * overlapping transactions, which no mock or in-memory fake reproduces. The unit tests in
 * lorebookMerge.test.ts already cover the merge itself; what breaks under concurrency is the
 * *composition* of read + merge + write, and only a live database exercises that.
 *
 * Skipped unless DATABASE_URL is set. Run with:
 *   docker compose up -d db && npm run db:push && npm test
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb("applyDeltaTransactional (requires Postgres)", () => {
  const db = new PrismaClient();
  const userId = "test-user-worldwrite";
  let worldId: string;

  beforeAll(async () => {
    const world = await db.lorebook.create({
      data: {
        userId,
        title: "Concurrency Test World",
        checkpoint: { characters: [], locations: [], items: [], rules: [], plot_threads: [], chronology: [] },
      },
    });
    worldId = world.id;
  });

  afterAll(async () => {
    await db.lorebook.deleteMany({ where: { userId } });
    await db.$disconnect();
  });

  const entityDelta = (name: string): LorebookDelta => ({
    add: [{ name, blurb: `${name} exists.`, importance: "middle" }],
    update: [],
  });

  it("does not lose entities when two writers race", async () => {
    // Both writes are issued without awaiting the first — they overlap in time, which is exactly
    // the Claude-Code-and-Hermes-at-once case. Without FOR UPDATE both read the same base
    // checkpoint and the second write erases the first's entity, silently.
    await Promise.all([
      applyDeltaTransactional(db, userId, worldId, entityDelta("Writer A Entity"), { skipSync: true }),
      applyDeltaTransactional(db, userId, worldId, entityDelta("Writer B Entity"), { skipSync: true }),
    ]);

    const world = await db.lorebook.findUniqueOrThrow({ where: { id: worldId } });
    const names = ((world.checkpoint as any).characters ?? []).map((c: any) => c.name);

    expect(names).toContain("Writer A Entity");
    expect(names).toContain("Writer B Entity");
  });

  it("advances the extraction sequence exactly once per write", async () => {
    const before = await db.lorebook.findUniqueOrThrow({ where: { id: worldId } });
    const seqBefore = (before.checkpoint as any)._extractionSeq ?? 0;

    const N = 5;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        applyDeltaTransactional(db, userId, worldId, entityDelta(`Seq Entity ${i}`), { skipSync: true }),
      ),
    );

    const after = await db.lorebook.findUniqueOrThrow({ where: { id: worldId } });
    // Serialized writers each see the previous one's seq, so N concurrent writes advance by
    // exactly N. If any two shared a base checkpoint, this lands short — the same failure that
    // loses entities, caught as an off-by-N.
    expect((after.checkpoint as any)._extractionSeq).toBe(seqBefore + N);
  });

  it("rejects a write to another user's world without mutating it", async () => {
    await expect(
      applyDeltaTransactional(db, "someone-else", worldId, entityDelta("Trespasser"), { skipSync: true }),
    ).rejects.toThrow(/not found/i);

    const world = await db.lorebook.findUniqueOrThrow({ where: { id: worldId } });
    const names = ((world.checkpoint as any).characters ?? []).map((c: any) => c.name);
    expect(names).not.toContain("Trespasser");
  });
});
