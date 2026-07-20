import type { PrismaClient } from "@prisma/client";
import { env } from "../env.js";
import type { EmbeddingRouterType } from "../services/embedding/index.js";

/**
 * Live runtime configuration, read from the `settings` row.
 *
 * Env supplies the seed values on first boot; after that the database row is authoritative, so the
 * settings UI can retune the daemon without a redeploy. API keys deliberately never live here —
 * they stay in env (see env.ts).
 */
export interface RuntimeSettings {
  embeddingEnabled: boolean;
  embeddingRouter: EmbeddingRouterType;
  embeddingModel: string | undefined;
  llmRouter: string;
  llmModel: string | undefined;
}

/**
 * Reads the owner's settings, creating the row from env defaults on first call.
 *
 * Not cached: a settings change made in the UI must take effect on the next request, and this is
 * a single indexed primary-key lookup against a one-row table.
 */
export async function getSettings(db: PrismaClient, userId: string = env.OWNER_ID): Promise<RuntimeSettings> {
  const row = await db.settings.upsert({
    where: { userId },
    // Only seeds a missing row — an existing row is returned untouched, so a redeploy with
    // different env values never silently overwrites what was set in the UI.
    update: {},
    create: {
      userId,
      embeddingRouter: env.EMBEDDING_ROUTER,
      embeddingModel: env.EMBEDDING_MODEL ?? null,
      llmRouter: env.LLM_ROUTER,
      llmModel: env.LLM_MODEL ?? null,
    },
  });

  return {
    embeddingEnabled: row.embeddingEnabled,
    embeddingRouter: row.embeddingRouter as EmbeddingRouterType,
    embeddingModel: row.embeddingModel ?? undefined,
    llmRouter: row.llmRouter,
    llmModel: row.llmModel ?? undefined,
  };
}

/** Applies a partial settings update from the UI. Returns the new live values. */
export async function updateSettings(
  db: PrismaClient,
  patch: Partial<Omit<RuntimeSettings, "embeddingRouter">> & { embeddingRouter?: string },
  userId: string = env.OWNER_ID,
): Promise<RuntimeSettings> {
  await getSettings(db, userId); // ensure the row exists
  await db.settings.update({
    where: { userId },
    data: {
      ...(patch.embeddingEnabled !== undefined && { embeddingEnabled: patch.embeddingEnabled }),
      ...(patch.embeddingRouter !== undefined && { embeddingRouter: patch.embeddingRouter }),
      ...(patch.embeddingModel !== undefined && { embeddingModel: patch.embeddingModel ?? null }),
      ...(patch.llmRouter !== undefined && { llmRouter: patch.llmRouter }),
      ...(patch.llmModel !== undefined && { llmModel: patch.llmModel ?? null }),
    },
  });
  return getSettings(db, userId);
}
