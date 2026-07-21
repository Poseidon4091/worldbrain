import type { PrismaClient } from "@prisma/client";
import { tagAppearsInText } from "../world/dciSearch.js";
import { EMBEDDING_DIM } from "./embeddingService.js";

// ───────────────── Memory Embedding Storage ─────────────────

/**
 * Stores an embedding vector for a memory using raw SQL (Prisma can't handle vector types).
 */
export async function storeMemoryEmbedding(
  db: PrismaClient,
  memoryId: string,
  embedding: number[],
  embeddingModel: string,
): Promise<void> {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}`);
  }

  const vectorStr = `[${embedding.join(",")}]`;
  await db.$executeRaw`
    UPDATE memories
    SET embedding = ${vectorStr}::vector,
        "embeddingModel" = ${embeddingModel},
        "embeddedAt" = NOW()
    WHERE id = ${memoryId}
  `;
}

/**
 * Batch-stores embeddings for multiple memories.
 */
export async function storeMemoryEmbeddingBatch(
  db: PrismaClient,
  items: Array<{ memoryId: string; embedding: number[]; embeddingModel: string }>,
): Promise<void> {
  for (const item of items) {
    await storeMemoryEmbedding(db, item.memoryId, item.embedding, item.embeddingModel);
  }
}

// ───────────────── Memory Vector Search ─────────────────

export interface SimilarMemory {
  id: string;
  content: string;
  similarity: number;
  importanceScore: number;
  kind: string;
  chatId: string | null;
  ariaPersonaId: string | null;
  userProfileId: string | null;
  worldId: string | null;
  createdAt: Date;
}

/**
 * Finds the most semantically similar memories to a query embedding.
 * Uses pgvector's cosine distance operator (<=>).
 * All values are parameterized ($1, $2, ...) to prevent SQL injection.
 */
export async function findSimilarMemories(
  db: PrismaClient,
  queryEmbedding: number[],
  userId: string,
  limit: number = 20,
  filters?: {
    chatId?: string;
    ariaPersonaId?: string;
    userProfileId?: string;
    worldId?: string;
    memoryScope?: "GLOBAL" | "PERSONA" | "PERSONA_PROFILE";
    minSimilarity?: number;
    /** Model that produced the query embedding. Rows embedded by a DIFFERENT
     *  model are excluded — cosine distance across embedding spaces is
     *  meaningless and degrades retrieval silently. NULL rows (pre-column
     *  legacy) are kept, matching their previous behavior. */
    embeddingModel?: string;
  },
): Promise<SimilarMemory[]> {
  if (queryEmbedding.length !== EMBEDDING_DIM) {
    throw new Error(`Query embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${queryEmbedding.length}`);
  }

  const vectorStr = `[${queryEmbedding.join(",")}]`;
  const minSim = filters?.minSimilarity ?? 0.3;

  // Build parameterized query with positional params
  const params: unknown[] = [];
  let idx = 1;

  const vectorParam = `$${idx++}`;
  params.push(vectorStr);

  const userIdParam = `$${idx++}`;
  params.push(userId);

  const conditions: string[] = [
    `"userId" = ${userIdParam}`,
    `"deletedAt" IS NULL`,
    `status = 'ACCEPTED'`,
    `enabled = true`,
    `embedding IS NOT NULL`,
  ];

  if (filters?.chatId) {
    conditions.push(`"chatId" = $${idx++}`);
    params.push(filters.chatId);
  }
  if (filters?.memoryScope === "GLOBAL") {
    conditions.push(`"ariaPersonaId" IS NULL`);
    conditions.push(`"userProfileId" IS NULL`);
  }
  if (filters?.memoryScope === "PERSONA" && filters?.ariaPersonaId) {
    conditions.push(`"ariaPersonaId" = $${idx++}`);
    params.push(filters.ariaPersonaId);
    conditions.push(`"userProfileId" IS NULL`);
  }
  if (filters?.memoryScope === "PERSONA_PROFILE") {
    if (filters?.ariaPersonaId) {
      conditions.push(`"ariaPersonaId" = $${idx++}`);
      params.push(filters.ariaPersonaId);
    }
    // If ariaPersonaId is omitted, leave unconstrained (don't force IS NULL)
    if (filters?.userProfileId) {
      conditions.push(`"userProfileId" = $${idx++}`);
      params.push(filters.userProfileId);
    }
    // If userProfileId is omitted, leave unconstrained (don't force IS NULL)
  }
  if (filters?.worldId) {
    conditions.push(`"worldId" = $${idx++}`);
    params.push(filters.worldId);
  }
  if (filters?.embeddingModel) {
    conditions.push(`("embeddingModel" IS NULL OR "embeddingModel" = $${idx++})`);
    params.push(filters.embeddingModel);
  }

  const minSimParam = `$${idx++}`;
  params.push(minSim);

  const limitParam = `$${idx++}`;
  params.push(limit);

  const whereClause = conditions.join(" AND ");

  const results = await db.$queryRawUnsafe<SimilarMemory[]>(
    `
    SELECT
      id,
      content,
      1 - (embedding <=> ${vectorParam}::vector) AS similarity,
      "importanceScore" AS "importanceScore",
      kind,
      "chatId",
      "ariaPersonaId",
      "userProfileId",
      "worldId",
      "createdAt"
    FROM memories
    WHERE ${whereClause}
      AND 1 - (embedding <=> ${vectorParam}::vector) >= ${minSimParam}
    ORDER BY embedding <=> ${vectorParam}::vector ASC
    LIMIT ${limitParam}
  `,
    ...params,
  );

  return results;
}

/**
 * Hybrid retrieval: combines vector similarity with importance score and recency.
 * Formula: hybridScore = (w_sim * similarity) + (w_imp * normalizedImportance) + (w_rec * recencyScore)
 */
export async function hybridMemorySearch(
  db: PrismaClient,
  queryEmbedding: number[],
  userId: string,
  limit: number = 20,
  filters?: {
    chatId?: string;
    ariaPersonaId?: string;
    userProfileId?: string;
    worldId?: string;
    memoryScope?: "GLOBAL" | "PERSONA" | "PERSONA_PROFILE";
    embeddingModel?: string;
  },
  weights?: {
    similarity?: number;
    importance?: number;
    recency?: number;
  },
): Promise<(SimilarMemory & { hybridScore: number })[]> {
  const wSim = weights?.similarity ?? 0.6;
  const wImp = weights?.importance ?? 0.3;
  const wRec = weights?.recency ?? 0.1;

  const candidates = await findSimilarMemories(db, queryEmbedding, userId, limit * 2, {
    ...filters,
    minSimilarity: 0.2,
  });

  if (candidates.length === 0) return [];

  const maxImportance = Math.max(...candidates.map((c) => c.importanceScore ?? 0), 1);
  const now = Date.now();
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000; // 30 days

  const scored = candidates.map((c) => {
    const normalizedImportance = (c.importanceScore ?? 0) / maxImportance;
    const ageMs = now - new Date(c.createdAt).getTime();
    const recencyScore = Math.max(0, 1 - ageMs / maxAgeMs);

    const hybridScore = wSim * c.similarity + wImp * normalizedImportance + wRec * recencyScore;

    return { ...c, hybridScore };
  });

  scored.sort((a, b) => b.hybridScore - a.hybridScore);
  return scored.slice(0, limit);
}

/**
 * Counts how many memories have embeddings (for backfill progress).
 */
export async function countEmbeddedMemories(
  db: PrismaClient,
  userId: string,
): Promise<{ total: number; embedded: number }> {
  const result = await db.$queryRaw<[{ total: bigint; embedded: bigint }]>`
    SELECT
      COUNT(*) AS total,
      COUNT(embedding) AS embedded
    FROM memories
    WHERE "userId" = ${userId}
      AND "deletedAt" IS NULL
      AND status = 'ACCEPTED'
  `;

  return {
    total: Number(result[0].total),
    embedded: Number(result[0].embedded),
  };
}

// ───────────────── World Item Embedding Storage ─────────────────

export async function storeItemEmbedding(
  db: PrismaClient,
  itemId: string,
  embedding: number[],
  embeddingModel: string,
): Promise<void> {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}`);
  }

  const vectorStr = `[${embedding.join(",")}]`;
  await db.$executeRaw`
    UPDATE world_items
    SET embedding = ${vectorStr}::vector,
        "embeddingModel" = ${embeddingModel},
        "embeddedAt" = NOW()
    WHERE id = ${itemId}
  `;
}

export async function storeItemEmbeddingBatch(
  db: PrismaClient,
  items: Array<{ itemId: string; embedding: number[]; embeddingModel: string }>,
): Promise<void> {
  for (const item of items) {
    await storeItemEmbedding(db, item.itemId, item.embedding, item.embeddingModel);
  }
}

// ───────────────── World Item Vector Search ─────────────────

export interface SimilarWorldItem {
  id: string;
  key: string;
  type: string;
  content: string;
  similarity: number;
  importanceScore: number;
  worldId: string;
  embeddingModel: string | null;
  canonBook: number | null;
  canonChapter: number | null;
  createdAt: Date;
}

export async function findSimilarItems(
  db: PrismaClient,
  queryEmbedding: number[],
  userId: string,
  worldIds: string[],
  limit: number = 20,
  minSimilarity: number = 0.3,
  canonPosition?: { book: number; chapter?: number } | null,
  /** Model that produced the query embedding — see findSimilarMemories.filters.embeddingModel. */
  embeddingModel?: string | null,
): Promise<SimilarWorldItem[]> {
  if (queryEmbedding.length !== EMBEDDING_DIM) {
    throw new Error(`Query embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${queryEmbedding.length}`);
  }
  if (worldIds.length === 0) return [];

  const vectorStr = `[${queryEmbedding.join(",")}]`;

  let canonClause = "";
  let modelClause = "";
  const params: unknown[] = [vectorStr, userId, worldIds, minSimilarity, limit];
  if (embeddingModel) {
    const modelParam = `$${params.length + 1}`;
    params.push(embeddingModel);
    modelClause = `AND (li."embeddingModel" IS NULL OR li."embeddingModel" = ${modelParam})`;
  }
  if (canonPosition) {
    const bookParam = `$${params.length + 1}`;
    params.push(canonPosition.book);
    if (canonPosition.chapter != null) {
      const chapterParam = `$${params.length + 1}`;
      params.push(canonPosition.chapter);
      canonClause = `AND (li."canonBook" IS NULL OR li."canonBook" < ${bookParam} OR (li."canonBook" = ${bookParam} AND (li."canonChapter" IS NULL OR li."canonChapter" <= ${chapterParam})))`;
    } else {
      canonClause = `AND (li."canonBook" IS NULL OR li."canonBook" <= ${bookParam})`;
    }
  }

  const results = await db.$queryRawUnsafe<SimilarWorldItem[]>(
    `
    SELECT
      li.id,
      li.key,
      li.type,
      li.content,
      1 - (li.embedding <=> $1::vector) AS similarity,
      li."importanceScore" AS "importanceScore",
      li."worldId",
      li."embeddingModel" AS "embeddingModel",
      li."canonBook" AS "canonBook",
      li."canonChapter" AS "canonChapter",
      li."createdAt"
    FROM world_items li
    JOIN worlds l ON li."worldId" = l.id
    WHERE l."userId" = $2
      AND li."worldId" = ANY($3::text[])
      AND li.embedding IS NOT NULL
      AND 1 - (li.embedding <=> $1::vector) >= $4
      ${modelClause}
      ${canonClause}
    ORDER BY li.embedding <=> $1::vector ASC
    LIMIT $5
  `,
    ...params,
  );

  return results;
}

export async function hybridSearch(
  db: PrismaClient,
  queryEmbedding: number[],
  userId: string,
  worldIds: string[],
  limit: number = 20,
  weights?: {
    similarity?: number;
    importance?: number;
    recency?: number;
  },
  canonPosition?: { book: number; chapter?: number } | null,
  embeddingModel?: string | null,
): Promise<(SimilarWorldItem & { hybridScore: number })[]> {
  const wSim = weights?.similarity ?? 0.6;
  const wImp = weights?.importance ?? 0.3;
  const wRec = weights?.recency ?? 0.1;

  const candidates = await findSimilarItems(
    db,
    queryEmbedding,
    userId,
    worldIds,
    limit * 2,
    0.2,
    canonPosition,
    embeddingModel,
  );

  if (candidates.length === 0) return [];

  const maxImportance = Math.max(...candidates.map((c) => c.importanceScore ?? 1), 1);
  const now = Date.now();
  const maxAgeMs = 180 * 24 * 60 * 60 * 1000; // 6 months for world items

  const scored = candidates.map((c) => {
    const normalizedImportance = (c.importanceScore ?? 1) / maxImportance;
    const ageMs = now - new Date(c.createdAt).getTime();
    const recencyScore = Math.max(0, 1 - ageMs / maxAgeMs);

    // Anti-self-echo penalty: passages created within the last 90 minutes are from the
    // current session. Scoring them at full similarity means the LLM's own recent output
    // immediately becomes its top context and gets echoed back. Apply a 0.25 penalty to
    // very-recent passages so established earlier context can compete.
    const isVeryRecentRpPassage = (c as any).type === "passage" && ageMs < 90 * 60 * 1000;
    const selfEchoPenalty = isVeryRecentRpPassage ? 0.25 : 0;

    const hybridScore = wSim * c.similarity + wImp * normalizedImportance + wRec * recencyScore - selfEchoPenalty;

    return { ...c, hybridScore };
  });

  scored.sort((a, b) => b.hybridScore - a.hybridScore);
  return scored.slice(0, limit);
}

/**
 * Tag-gated world retrieval: mirrors the pre-RAG tag-trigger system.
 *
 * Behavior (matches old system exactly):
 *   1. Entry-level match: if any entry's tags appear in the user message, return those
 *      specific entries — entry tag wins over the world-level tag.
 *   2. World-level match: if no entry tags matched but the world's own tags appear
 *      in the user message, return all entries (entire world is in scope this turn).
 *   3. No match: return nothing.
 *
 * Used for in-world item worlds (e.g. a research notebook) where characters should
 * only reference content they have been explicitly shown, not semantic inferences.
 */
export async function tagGatedSearch(
  db: PrismaClient,
  userMessage: string,
  world: { id: string; tags: string[] },
): Promise<{ worldId: string; key: string; type: string; content: string }[]> {
  // Fetch all items for this world (tag-gated worlds are typically small).
  // Tags are stored inside the content JSON field (not a separate column).
  const rawItems = await db.worldItem.findMany({
    where: { worldId: world.id },
    select: { key: true, type: true, content: true },
  });

  if (rawItems.length === 0) return [];

  // Parse content JSON to extract tags for each item
  const items = rawItems.map((item) => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(item.content ?? "{}");
      tags = Array.isArray(parsed.tags) ? parsed.tags : [];
    } catch {
      // malformed content — no tags
    }
    return { ...item, tags };
  });

  // Step 1: entry-level tag matching — return only the specific matched entries.
  // Word-boundary match (not raw substring) so tag "art" doesn't fire on "start", but tolerant
  // of plural/possessive inflection so "notebook" still fires on "notebooks".
  const entryMatches = items.filter((item) =>
    item.tags.some((tag) => tag.trim().length > 0 && tagAppearsInText(tag, userMessage)),
  );

  if (entryMatches.length > 0) {
    return entryMatches.map((item) => ({
      worldId: world.id,
      key: item.key,
      type: item.type,
      content: item.content ?? "",
    }));
  }

  // Step 2: world-level tag match → entire world is in scope this turn
  const worldTagMatched = world.tags.some(
    (tag) => tag.trim().length > 0 && tagAppearsInText(tag, userMessage),
  );

  if (worldTagMatched) {
    return items.map((item) => ({
      worldId: world.id,
      key: item.key,
      type: item.type,
      content: item.content ?? "",
    }));
  }

  return [];
}
