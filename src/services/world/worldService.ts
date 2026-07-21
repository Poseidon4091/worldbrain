import type { PrismaClient } from "@prisma/client";

/**
 * Minimal standalone world/world CRUD for worldbrain — the un-coupled replacement for Aria's
 * worldService (which was wired to chatGraph / graphLorebookRef / chat / chatSummary).
 *
 * Ownership is by plain `userId` string; callers layer their own auth/scoping (per the MCP plan,
 * a token → userId maps every request to that user's worlds).
 */
export function createWorldService(db: PrismaClient) {
  async function list(userId: string) {
    return db.world.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  }

  async function get(userId: string, worldId: string) {
    const world = await db.world.findUnique({ where: { id: worldId } });
    if (!world || world.userId !== userId) return null;
    return world;
  }

  async function create(userId: string, data: { title: string; group?: string | null; tags?: string[]; isReference?: boolean; tagGated?: boolean }) {
    return db.world.create({
      data: {
        userId,
        title: data.title,
        group: data.group ?? null,
        tags: data.tags ?? [],
        isReference: data.isReference ?? false,
        tagGated: data.tagGated ?? false,
        checkpoint: { characters: [], locations: [], items: [], rules: [], plot_threads: [], chronology: [], knowledge: [], events: [] },
      },
    });
  }

  /**
   * Blind full-checkpoint overwrite. UNSAFE for normal writes: it has no row lock, so two callers
   * that read-modify-write concurrently silently lose one side's entities. Use
   * `applyDeltaTransactional` instead — it takes a delta and serializes writers.
   *
   * Retained only for restore/import flows, where clobbering the current checkpoint is the intent.
   */
  async function overwriteCheckpointUnsafe(userId: string, worldId: string, checkpoint: unknown) {
    const world = await get(userId, worldId);
    if (!world) return null;
    return db.world.update({ where: { id: worldId }, data: { checkpoint: checkpoint as any } });
  }

  async function update(
    userId: string,
    worldId: string,
    data: { title?: string; group?: string | null; tags?: string[]; isReference?: boolean; tagGated?: boolean },
  ) {
    const world = await get(userId, worldId);
    if (!world) return null;
    return db.world.update({ where: { id: worldId }, data });
  }

  async function remove(userId: string, worldId: string) {
    const world = await get(userId, worldId);
    if (!world) return null;
    await db.memory.updateMany({ where: { worldId: worldId }, data: { worldId: null } });
    return db.world.delete({ where: { id: worldId } });
  }

  async function getItems(userId: string, worldId: string, opts?: { limit?: number }) {
    const world = await get(userId, worldId);
    if (!world) return null;
    return db.worldItem.findMany({
      where: { worldId: worldId },
      orderBy: [{ canonBook: "asc" }, { canonChapter: "asc" }, { key: "asc" }],
      take: Math.min(Math.max(opts?.limit ?? 60, 1), 500),
    });
  }

  async function getCheckpoints(userId: string, worldId: string) {
    const world = await get(userId, worldId);
    if (!world) return null;
    return db.worldCheckpoint.findMany({ where: { worldId: worldId }, orderBy: { createdAt: "desc" } });
  }

  return { list, get, create, update, overwriteCheckpointUnsafe, remove, getItems, getCheckpoints };
}

export type WorldService = ReturnType<typeof createWorldService>;
