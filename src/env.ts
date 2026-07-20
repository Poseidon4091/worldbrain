/**
 * Environment config for worldbrain. Minimal + lazy — reads process.env with sensible
 * fallbacks. Only the DATABASE_URL is strictly required (for Prisma); LLM/embedding keys
 * are required only if you use the ingest/embedding paths.
 *
 * Provider settings here are only DEFAULTS: they seed the `settings` row on first boot, after
 * which the live values come from the database so the settings UI can retune the daemon without
 * a redeploy. API keys are the exception — they are read from env every time and never stored in
 * the database, so the settings UI has nothing sensitive to render back.
 */
export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",

  /**
   * The single owner every world is scoped to. worldbrain's deployment model is one user per
   * instance (see docs/01_architecture.md §1), so this stands in for the multi-tenant userId the
   * engine's ownership checks still take. Fixed by default — override only when migrating data
   * that was written under a different id.
   */
  OWNER_ID: process.env.WORLDBRAIN_OWNER_ID ?? "worldbrain-owner",

  /** HTTP port for the MCP endpoint + settings UI. */
  PORT: Number(process.env.PORT ?? 8080),

  // Embedding providers (see embeddingService.ts)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_EXTERNAL_API_KEY: process.env.OPENROUTER_EXTERNAL_API_KEY,
  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  APP_URL: process.env.APP_URL ?? "http://localhost:8080",

  // Defaults seeded into the `settings` row on first boot.
  EMBEDDING_ROUTER: process.env.EMBEDDING_ROUTER ?? "openai",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
  LLM_ROUTER: process.env.LLM_ROUTER ?? "openai",
  LLM_MODEL: process.env.LLM_MODEL,

  // LLM chat (ingest) — OpenAI-compatible endpoints, see routerDispatch.ts
  NANOGPT_API_KEY: process.env.NANOGPT_API_KEY,
  NANOGPT_BASE_URL: process.env.NANOGPT_BASE_URL,
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
} as const;
