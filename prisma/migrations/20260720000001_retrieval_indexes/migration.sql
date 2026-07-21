-- Retrieval indexes. Prisma cannot express either of these in schema.prisma:
-- pgvector index types are unknown to it, and it has no syntax for a functional index.
-- Without them BOTH retrieval paths degrade to sequential scans over every row.

-- ── Vector similarity (HNSW) ────────────────────────────────────────────────
-- Used by findSimilarItems / hybridSearch via the `<=>` cosine-distance operator, so the
-- opclass must be vector_cosine_ops. An index built for a different distance operator is simply
-- ignored by the planner — it does not error, it just silently stops being used.
--
-- HNSW over IVFFlat: IVFFlat needs a representative sample of rows to build its lists, so
-- building it on an empty table (which is exactly what a fresh install is) produces a badly
-- clustered index. HNSW has no such requirement and its recall degrades more gracefully.
--
-- m / ef_construction are pgvector's defaults. Raising them improves recall at the cost of
-- build time and memory; not worth tuning until there is real data to measure against.
CREATE INDEX IF NOT EXISTS "world_items_embedding_hnsw_idx"
  ON "world_items" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "memories_embedding_hnsw_idx"
  ON "memories" USING hnsw ("embedding" vector_cosine_ops);

-- ── DCI exact-name lookup ───────────────────────────────────────────────────
-- dciLookupByNames matches `lower(key) = ANY($2::text[])`. The plain b-tree on (worldId, key)
-- cannot serve that predicate because of the lower() call, so this functional index is what
-- makes exact-name recall O(log n) instead of a full scan of the book.
CREATE INDEX IF NOT EXISTS "world_items_lower_key_idx"
  ON "world_items" (lower("key"));
