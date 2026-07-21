import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../../utils/logger.js";
import { folderConnector } from "./folderConnector.js";
import { ingestDocuments } from "./ingestPipeline.js";
import type { SourceConnector } from "./types.js";

const logger = createLogger("ingest:worker");

/**
 * Registered connectors, by Source.type. "http" has no entry: it is push-driven via /ingest and
 * has nothing to poll, so the worker skips it rather than erroring on an unknown type.
 */
const CONNECTORS: Record<string, SourceConnector> = {
  [folderConnector.type]: folderConnector,
};

export interface SyncWorkerOptions {
  intervalMs?: number;
  /** Resolves the extraction model at run time, so a settings change takes effect next tick. */
  getConfig: () => Promise<{ llmRouter: string; llmModel: string }>;
}

/** Default poll cadence. Ingest costs tokens, so this is deliberately unhurried. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Background poller: walks every enabled source, ingests what changed, records failures.
 *
 * Runs in-process on a timer rather than as a separate worker tier — at single-user scale a queue
 * would be more moving parts than the thing it coordinates. If ingest ever starts blocking the
 * event loop, this is the seam to split out.
 */
export function startSyncWorker(db: PrismaClient, opts: SyncWorkerOptions): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Guards against overlapping runs: a slow pass (many documents, slow provider) must not have a
  // second pass start on top of it and ingest the same documents twice.
  let running = false;

  async function tick() {
    if (running) {
      logger.debug("Skipping tick — previous pass still running");
      return;
    }
    running = true;

    try {
      const sources = await db.source.findMany({ where: { enabled: true } });
      if (sources.length === 0) return;

      const config = await opts.getConfig();

      for (const source of sources) {
        const connector = CONNECTORS[source.type];
        if (!connector) continue; // push-driven or unknown type — nothing to poll

        try {
          const docs = await connector.poll((source.config as Record<string, unknown>) ?? {});
          const result = await ingestDocuments(db, source.userId, source.worldId, source.id, docs, config);

          await db.source.update({
            where: { id: source.id },
            data: { lastSyncAt: new Date(), lastError: null },
          });

          if (result.ingested > 0 || result.failed > 0) {
            logger.info("Source synced", { sourceId: source.id, type: source.type, ...result });
          }
        } catch (err) {
          // Failure isolation: one broken source (bad path, unreachable mount) must never stop
          // the others. The error is persisted so it shows up rather than failing silently.
          logger.error("Source sync failed", { sourceId: source.id, type: source.type, err });
          await db.source
            .update({ where: { id: source.id }, data: { lastSyncAt: new Date(), lastError: String(err) } })
            .catch(() => {});
        }
      }
    } catch (err) {
      logger.error("Sync pass failed", { err });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  // Don't hold the process open on this timer alone — the HTTP server owns the lifecycle.
  timer.unref();

  logger.info("Sync worker started", { intervalMs });
  return { stop: () => clearInterval(timer) };
}
