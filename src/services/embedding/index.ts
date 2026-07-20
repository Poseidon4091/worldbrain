export type { EmbeddingMode, EmbeddingProvider, EmbeddingResult, EmbeddingRouterType } from "./embeddingService.js";
export { EMBEDDING_DIM, embedBatch, embedText, getEmbeddingProvider, validateEmbedding } from "./embeddingService.js";
export {
  countEmbeddedMemories,
  findSimilarLorebookItems,
  findSimilarMemories,
  hybridLorebookSearch,
  hybridMemorySearch,
  type SimilarLorebookItem,
  type SimilarMemory,
  storeLorebookEmbedding,
  storeLorebookEmbeddingBatch,
  storeMemoryEmbedding,
  storeMemoryEmbeddingBatch,
  tagGatedLorebookSearch,
} from "./vectorSearch.js";
