import { env } from "../../env.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("embeddings");

/** Standard embedding dimension — matches the `vector(1024)` column in Prisma schema. */
export const EMBEDDING_DIM = 1024;

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokensUsed: number;
}

/** Whether we're embedding a document (for storage) or a query (for retrieval) */
export type EmbeddingMode = "document" | "query";

export interface EmbeddingProvider {
  name: string;
  embed(texts: string[], mode?: EmbeddingMode): Promise<EmbeddingResult[]>;
}

/** Response shape of the OpenAI-compatible `/embeddings` endpoint (OpenAI, OpenRouter, Voyage). */
interface OpenAIEmbeddingsResponse {
  data: Array<{ embedding: number[] }>;
  usage?: { total_tokens?: number };
}

/** Ollama's `/api/embed` response — newer builds return `embeddings`, older ones `embedding`. */
interface OllamaEmbeddingsResponse {
  embeddings?: number[][];
  embedding?: number[];
}

// ───────────────── OpenAI Provider ─────────────────

function createOpenAIProvider(apiKey: string, model: string = "text-embedding-3-small"): EmbeddingProvider {
  return {
    name: "openai",
    async embed(texts: string[]): Promise<EmbeddingResult[]> {
      const start = Date.now();
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: texts,
          dimensions: EMBEDDING_DIM, // Truncate to 1024 to match pgvector column
          encoding_format: "float",
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI Embeddings API error: ${res.status} ${body}`);
      }

      const data = (await res.json()) as OpenAIEmbeddingsResponse;
      const totalTokens = data.usage?.total_tokens ?? 0;
      const perTextTokens = Math.ceil(totalTokens / texts.length);
      const duration = Date.now() - start;

      logger.info(`OpenAI Embeddings generated`, { model, count: texts.length, totalTokens, durationMs: duration });

      return (data.data as any[]).map((item: any) => ({
        embedding: item.embedding,
        model,
        tokensUsed: perTextTokens,
      }));
    },
  };
}

// ───────────────── OpenRouter Provider ─────────────────
// Uses OpenRouter's OpenAI-compatible embeddings endpoint

function createOpenRouterEmbeddingProvider(
  apiKey: string,
  model: string = "openai/text-embedding-3-small",
): EmbeddingProvider {
  return {
    name: "openrouter",
    async embed(texts: string[]): Promise<EmbeddingResult[]> {
      const start = Date.now();
      const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.APP_URL,
          "X-OpenRouter-Title": "worldbrain",
        },
        body: JSON.stringify({
          model,
          input: texts,
          dimensions: EMBEDDING_DIM,
          encoding_format: "float",
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenRouter Embeddings API error: ${res.status} ${body}`);
      }

      const data = (await res.json()) as OpenAIEmbeddingsResponse;
      const totalTokens = data.usage?.total_tokens ?? 0;
      const perTextTokens = Math.ceil(totalTokens / texts.length);
      const duration = Date.now() - start;

      logger.info(`OpenRouter Embeddings generated`, { model, count: texts.length, totalTokens, durationMs: duration });

      return (data.data as any[]).map((item: any) => ({
        embedding: item.embedding,
        model,
        tokensUsed: perTextTokens,
      }));
    },
  };
}

// ───────────────── Local / Ollama Provider ─────────────────

/**
 * Model-specific query prefixes for instruction-aware embedding models.
 * Documents never get prefixed — only queries need instructions.
 */
function getOllamaQueryPrefix(model: string, text: string): string {
  const m = model.toLowerCase();
  if (m.includes("qwen3-embedding")) {
    return `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ${text}`;
  }
  if (m.includes("arctic-embed") || m.includes("snowflake")) {
    return `query: ${text}`;
  }
  if (m.includes("nomic-embed")) {
    return `search_query: ${text}`;
  }
  if (m.includes("e5")) {
    return `query: ${text}`;
  }
  // Unknown model — no prefix (safe fallback)
  return text;
}

function createOllamaProvider(
  baseUrl: string = "http://localhost:11434",
  model: string = "nomic-embed-text",
): EmbeddingProvider {
  return {
    name: "ollama",
    async embed(texts: string[], mode?: EmbeddingMode): Promise<EmbeddingResult[]> {
      const start = Date.now();
      // Ollama doesn't support batch — call sequentially
      const results: EmbeddingResult[] = [];
      for (const text of texts) {
        // Apply model-specific prefix for queries only
        const input = mode === "query" ? getOllamaQueryPrefix(model, text) : text;

        const res = await fetch(`${baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Ollama Embeddings error: ${res.status} ${body}`);
        }

        const data = (await res.json()) as OllamaEmbeddingsResponse;
        let embedding: number[] = data.embeddings?.[0] ?? data.embedding ?? [];

        // Truncate or pad to match target dimension
        if (embedding.length > EMBEDDING_DIM) {
          embedding = embedding.slice(0, EMBEDDING_DIM);
        } else if (embedding.length < EMBEDDING_DIM) {
          embedding = [...embedding, ...new Array(EMBEDDING_DIM - embedding.length).fill(0)];
        }

        results.push({ embedding, model, tokensUsed: 0 });
      }
      const duration = Date.now() - start;
      logger.info(`Ollama Embeddings generated`, {
        model,
        count: texts.length,
        mode: mode ?? "default",
        durationMs: duration,
      });
      return results;
    },
  };
}

// ───────────────── Voyage AI Provider ─────────────────
// Voyage-3 defaults to 1024 dimensions.

function createVoyageProvider(apiKey: string, model: string = "voyage-3"): EmbeddingProvider {
  return {
    name: "voyage",
    async embed(texts: string[]): Promise<EmbeddingResult[]> {
      const start = Date.now();
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Voyage AI Embeddings API error: ${res.status} ${body}`);
      }

      const data = (await res.json()) as OpenAIEmbeddingsResponse;
      const totalTokens = data.usage?.total_tokens ?? 0;
      const perTextTokens = Math.ceil(totalTokens / texts.length);
      const duration = Date.now() - start;

      logger.info(`Voyage AI Embeddings generated`, { model, count: texts.length, totalTokens, durationMs: duration });

      return (data.data as any[]).map((item: any) => {
        let embedding = item.embedding;
        // Ensure 1024 dimensions
        if (embedding.length > EMBEDDING_DIM) {
          embedding = embedding.slice(0, EMBEDDING_DIM);
        } else if (embedding.length < EMBEDDING_DIM) {
          embedding = [...embedding, ...new Array(EMBEDDING_DIM - embedding.length).fill(0)];
        }

        return {
          embedding,
          model,
          tokensUsed: perTextTokens,
        };
      });
    },
  };
}

// ───────────────── Provider Factory ─────────────────

export type EmbeddingRouterType = "openai" | "openrouter" | "openrouter_external" | "ollama" | "voyage";

const providerCache = new Map<string, EmbeddingProvider>();

/**
 * Creates or retrieves a cached embedding provider.
 *
 * @param router - Which embedding provider to use
 * @param model  - The specific model (provider-dependent, e.g. "text-embedding-3-small")
 */
export function getEmbeddingProvider(router: EmbeddingRouterType = "openai", model?: string): EmbeddingProvider {
  const cacheKey = `${router}:${model ?? "default"}`;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  let provider: EmbeddingProvider;

  switch (router) {
    case "openai":
      if (!env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for OpenAI embeddings");
      }
      provider = createOpenAIProvider(env.OPENAI_API_KEY, model ?? "text-embedding-3-small");
      break;
    case "openrouter":
      if (!env.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY is required for OpenRouter embeddings");
      }
      provider = createOpenRouterEmbeddingProvider(env.OPENROUTER_API_KEY, model ?? "openai/text-embedding-3-small");
      break;
    case "openrouter_external":
      if (!env.OPENROUTER_EXTERNAL_API_KEY) {
        throw new Error("OPENROUTER_EXTERNAL_API_KEY is required for OpenRouter External embeddings");
      }
      provider = createOpenRouterEmbeddingProvider(
        env.OPENROUTER_EXTERNAL_API_KEY,
        model ?? "openai/text-embedding-3-small",
      );
      break;
    case "ollama":
      provider = createOllamaProvider(env.OLLAMA_BASE_URL ?? "http://localhost:11434", model ?? "nomic-embed-text");
      break;
    case "voyage":
      if (!env.VOYAGE_API_KEY) {
        throw new Error("VOYAGE_API_KEY is required for Voyage AI embeddings");
      }
      provider = createVoyageProvider(env.VOYAGE_API_KEY, model ?? "voyage-3");
      break;
    default:
      throw new Error(`Unknown embedding router: ${router}`);
  }

  providerCache.set(cacheKey, provider);
  return provider;
}

// ───────────────── High-Level API ─────────────────

/**
 * Embeds a single text string. Returns a 1024-dim float array.
 */
export async function embedText(
  text: string,
  router?: EmbeddingRouterType,
  model?: string,
  mode?: EmbeddingMode,
): Promise<EmbeddingResult> {
  const provider = getEmbeddingProvider(router, model);
  const results = await provider.embed([text], mode);
  if (!results[0]) throw new Error("Embedding provider returned empty result");
  return results[0];
}

/**
 * Embeds multiple texts in a single batch call (where supported).
 * Returns results in the same order as input.
 */
export async function embedBatch(
  texts: string[],
  router?: EmbeddingRouterType,
  model?: string,
  mode?: EmbeddingMode,
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const provider = getEmbeddingProvider(router, model);

  // Most providers cap at ~2048 items per batch — chunk accordingly
  const MAX_BATCH = 100;
  const results: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const chunk = texts.slice(i, i + MAX_BATCH);
    const chunkResults = await provider.embed(chunk, mode);
    results.push(...chunkResults);
  }

  return results;
}

/**
 * Validates that an embedding has the correct dimension.
 */
export function validateEmbedding(embedding: number[]): boolean {
  return Array.isArray(embedding) && embedding.length === EMBEDDING_DIM;
}
