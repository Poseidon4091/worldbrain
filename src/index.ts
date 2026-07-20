/**
 * worldbrain — public API surface.
 *
 * The lorebook framework extracted from Aria, un-coupled and repurposed as a standalone,
 * embeddings-backed, MCP-ready persistent world/context store. See docs/00_plan.md.
 */

// ── Retrieval (vector + hybrid + tag-gated) ──────────────────────────────────
export {
  findSimilarLorebookItems,
  hybridLorebookSearch,
  tagGatedLorebookSearch,
  findSimilarMemories,
  hybridMemorySearch,
  storeLorebookEmbedding,
  storeLorebookEmbeddingBatch,
  storeMemoryEmbedding,
  countEmbeddedMemories,
  type SimilarLorebookItem,
  type SimilarMemory,
} from "./services/embedding/vectorSearch.js";

// ── DCI: exact-name recall + mention detection + tag/phrase matching ─────────
export {
  dciAugmentRetrievedItems,
  dciLookupByNames,
  extractMentionedEntities,
  formatEntitiesForLibrarian,
  nameAppearsInText,
  phraseAppearsInText,
  tagAppearsInText,
} from "./services/lorebook/lorebookDciSearch.js";

// ── Merge engine (delta application, dedup, fuzzy matching) ───────────────────
export {
  applyLorebookDelta,
  normalizeName,
  type LorebookCheckpoint,
  type LorebookDelta,
  type LorebookEntity,
} from "./services/lorebook/lorebookMerge.js";

// ── Bounded-memory lifecycle (recency, rollup, dormancy) ─────────────────────
export {
  stampRecency,
  rollupChronology,
  selectCoreFloor,
  isEntityDormant,
  buildActiveNameSet,
  nextExtractionSeq,
  DEFAULT_DORMANCY_THRESHOLD,
} from "./services/lorebook/lorebookLifecycle.js";

// ── Sync (checkpoint → relational items + embeddings; RP passage chunking) ───
export { syncLorebookItemsAndEmbed } from "./services/lorebook/lorebookItemSync.js";
export { syncRpPassages, getPassageWatermark, type RpMessage } from "./services/lorebook/rpPassageSync.js";
export { applyRetrievalFeedback } from "./services/lorebook/retrievalFeedback.js";

// ── Self-updating ingest (LLM extraction → delta) ────────────────────────────
export { extractNarrativeDelta } from "./services/intelligence/narrativeIntelligence.js";
export { unifiedExtractionSchema, type UnifiedExtractionResult } from "./services/intelligence/types.js";

// ── Embedding client ─────────────────────────────────────────────────────────
export { embedText, embedBatch, EMBEDDING_DIM, type EmbeddingRouterType } from "./services/embedding/index.js";

// ── World CRUD ───────────────────────────────────────────────────────────────
export { createWorldService, type WorldService } from "./services/lorebook/worldService.js";
