import type { PrismaClient } from "@prisma/client";

/**
 * Minimal standalone world/lorebook CRUD for worldbrain — the un-coupled replacement for Aria's
 * lorebookService (which was wired to chatGraph / graphLorebookRef / chat / chatSummary).
 *
 * Ownership is by plain `userId` string; callers layer their own auth/scoping (per the MCP plan,
 * a token → userId maps every request to that user's worlds).
 */
export function createWorldService(db: PrismaClient) {
  async function list(userId: string) {
    return db.lorebook.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  }

  async function get(userId: string, worldId: string) {
    const world = await db.lorebook.findUnique({ where: { id: worldId } });
    if (!world || world.userId !== userId) return null;
    return world;
  }

  async function create(userId: string, data: { title: string; group?: string | null; tags?: string[]; isReference?: boolean; tagGated?: boolean }) {
    return db.lorebook.create({
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

  async function saveCheckpoint(userId: string, worldId: string, checkpoint: unknown) {
    const world = await get(userId, worldId);
    if (!world) return null;
    return db.lorebook.update({ where: { id: worldId }, data: { checkpoint: checkpoint as any } });
  }

  async function update(
    userId: string,
    worldId: string,
    data: { title?: string; group?: string | null; tags?: string[]; isReference?: boolean; tagGated?: boolean },
  ) {
    const world = await get(userId, worldId);
    if (!world) return null;
    return db.lorebook.update({ where: { id: worldId }, data });
  }

  async function remove(userId: string, worldId: string) {
    const world = await get(userId, worldId);
    if (!world) return null;
    await db.memory.updateMany({ where: { lorebookId: worldId }, data: { lorebookId: null } });
    return db.lorebook.delete({ where: { id: worldId } });
  }

  async function getItems(userId: string, worldId: string, opts?: { limit?: number }) {
    const world = await get(userId, worldId);
    if (!world) return null;
    return db.lorebookItem.findMany({
      where: { lorebookId: worldId },
      orderBy: [{ canonBook: "asc" }, { canonChapter: "asc" }, { key: "asc" }],
      take: Math.min(Math.max(opts?.limit ?? 60, 1), 500),
    });
  }

  async function getCheckpoints(userId: string, worldId: string) {
    const world = await get(userId, worldId);
    if (!world) return null;
    return db.lorebookCheckpoint.findMany({ where: { lorebookId: worldId }, orderBy: { createdAt: "desc" } });
  }

  return { list, get, create, update, saveCheckpoint, remove, getItems, getCheckpoints };
}

export type WorldService = ReturnType<typeof createWorldService>;
