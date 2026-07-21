/**
 * worldbrain — public API surface.
 *
 * The world framework extracted from Aria, un-coupled and repurposed as a standalone,
 * embeddings-backed, MCP-ready persistent world/context store. See docs/00_plan.md.
 */

// ── Retrieval (vector + hybrid + tag-gated) ──────────────────────────────────
export {
  findSimilarItems,
  hybridSearch,
  tagGatedSearch,
  findSimilarMemories,
  hybridMemorySearch,
  storeItemEmbedding,
  storeItemEmbeddingBatch,
  storeMemoryEmbedding,
  countEmbeddedMemories,
  type SimilarWorldItem,
  type SimilarMemory,
} from "./services/embedding/vectorSearch.js";

// ── DCI: exact-name recall + mention detection + tag/phrase matching ─────────
export {
  dciAugmentRetrievedItems,
  dciLookupByNames,
  extractMentionedEntities,
  formatEntitiesForExtraction,
  nameAppearsInText,
  phraseAppearsInText,
  tagAppearsInText,
} from "./services/world/dciSearch.js";

// ── Merge engine (delta application, dedup, fuzzy matching) ───────────────────
export {
  applyDelta,
  normalizeName,
  type WorldCheckpoint,
  type WorldDelta,
  type WorldEntity,
} from "./services/world/merge.js";

// ── Bounded-memory lifecycle (recency, rollup, dormancy) ─────────────────────
export {
  stampRecency,
  rollupChronology,
  selectCoreFloor,
  isEntityDormant,
  buildActiveNameSet,
  nextExtractionSeq,
  DEFAULT_DORMANCY_THRESHOLD,
} from "./services/world/lifecycle.js";

// ── Sync (checkpoint → relational items + embeddings; RP passage chunking) ───
export { syncWorldItemsAndEmbed } from "./services/world/itemSync.js";
export { syncPassages, getPassageWatermark, type TranscriptMessage } from "./services/world/passageSync.js";
export { applyRetrievalFeedback } from "./services/world/retrievalFeedback.js";

// ── Self-updating ingest (LLM extraction → delta) ────────────────────────────
export { extractDelta } from "./services/intelligence/extraction.js";
export { unifiedExtractionSchema, type UnifiedExtractionResult } from "./services/intelligence/types.js";

// ── Embedding client ─────────────────────────────────────────────────────────
export { embedText, embedBatch, EMBEDDING_DIM, type EmbeddingRouterType } from "./services/embedding/index.js";

// ── World CRUD ───────────────────────────────────────────────────────────────
export { createWorldService, type WorldService } from "./services/world/worldService.js";

// ── Transactional write path (the only sanctioned checkpoint mutation) ───────
export {
  applyDeltaTransactional,
  type ApplyDeltaOptions,
  type ApplyDeltaResult,
} from "./services/world/worldWrite.js";
