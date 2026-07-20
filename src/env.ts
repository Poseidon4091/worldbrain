/**
 * Environment config for worldbrain. Minimal + lazy — reads process.env with sensible
 * fallbacks. Only the DATABASE_URL is strictly required (for Prisma); LLM/embedding keys
 * are required only if you use the ingest/embedding paths.
 */
export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",

  // Embedding providers (see embeddingService.ts)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_EXTERNAL_API_KEY: process.env.OPENROUTER_EXTERNAL_API_KEY,
  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  APP_URL: process.env.APP_URL ?? "http://localhost:3000",

  // LLM chat (ingest) — OpenAI-compatible endpoints, see routerDispatch.ts
  NANOGPT_API_KEY: process.env.NANOGPT_API_KEY,
  NANOGPT_BASE_URL: process.env.NANOGPT_BASE_URL,
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
} as const;
