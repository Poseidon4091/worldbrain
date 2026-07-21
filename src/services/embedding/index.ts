export type { EmbeddingMode, EmbeddingProvider, EmbeddingResult, EmbeddingRouterType } from "./embeddingService.js";
export { EMBEDDING_DIM, embedBatch, embedText, getEmbeddingProvider, validateEmbedding } from "./embeddingService.js";
export {
  countEmbeddedMemories,
  findSimilarItems,
  findSimilarMemories,
  hybridSearch,
  hybridMemorySearch,
  type SimilarWorldItem,
  type SimilarMemory,
  storeItemEmbedding,
  storeItemEmbeddingBatch,
  storeMemoryEmbedding,
  storeMemoryEmbeddingBatch,
  tagGatedSearch,
} from "./vectorSearch.js";
