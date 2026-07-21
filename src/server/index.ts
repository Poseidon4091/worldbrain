import { createHash } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PrismaClient } from "@prisma/client";
import express from "express";
import { ingestDocuments } from "../services/ingest/ingestPipeline.js";
import { startSyncWorker } from "../services/ingest/syncWorker.js";
import { env } from "../env.js";
import { createLogger } from "../utils/logger.js";
import { createMcpServer } from "./mcp.js";
import { getSettings, updateSettings } from "./settings.js";
import { SETTINGS_PAGE } from "./ui.js";
import { createWorldService } from "../services/world/worldService.js";
import type { WorldCheckpoint } from "../services/world/merge.js";

const logger = createLogger("server");

const db = new PrismaClient();
const app = express();
app.use(express.json({ limit: "8mb" }));

/**
 * MCP over streamable HTTP.
 *
 * Stateless: a fresh server + transport per request, with no session id. worldbrain's tools are
 * all self-contained request/response calls with no cross-call state, so sessions would buy
 * nothing while adding a session table to expire and leak. It also means a restart never
 * invalidates a client's connection.
 */
app.post("/mcp", async (req, res) => {
  const server = createMcpServer(db);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Both must be torn down per request or each call leaks a server instance.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error("MCP request failed", { err });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE /mcp are for server-initiated streams and session teardown — neither applies in
// stateless mode, so answer explicitly rather than letting clients hang on a 404.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: this server is stateless." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

/** Health check — Dokploy/Traefik use this to decide the container is live. */
app.get("/health", async (_req, res) => {
  try {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (err) {
    logger.error("Health check failed", { err });
    res.status(503).json({ status: "degraded", error: "database unreachable" });
  }
});

// ── Settings API (backs the UI) ──────────────────────────────────────────────
// API keys are never returned: they live in env only, so there is nothing sensitive to render.
app.get("/api/settings", async (_req, res) => {
  res.json(await getSettings(db));
});

app.patch("/api/settings", async (req, res) => {
  try {
    res.json(await updateSettings(db, req.body ?? {}));
  } catch (err) {
    logger.error("Settings update failed", { err });
    res.status(400).json({ error: "Invalid settings payload" });
  }
});

/** Book list for the UI. Summary only — the UI never needs full checkpoints. */
const worldService = createWorldService(db);
app.get("/api/worlds", async (_req, res) => {
  try {
    const worlds = await worldService.list(env.OWNER_ID);
    res.json(
      worlds.map((w) => {
        const cp = (w.checkpoint as WorldCheckpoint | null) ?? ({} as WorldCheckpoint);
        return {
          id: w.id,
          title: w.title,
          tags: w.tags,
          tagGated: w.tagGated,
          readOnly: w.readOnly,
          updatedAt: w.updatedAt,
          entityCount:
            (cp.characters?.length ?? 0) +
            (cp.locations?.length ?? 0) +
            (cp.items?.length ?? 0) +
            (cp.knowledge?.length ?? 0) +
            (cp.events?.length ?? 0),
        };
      }),
    );
  } catch (err) {
    logger.error("World list failed", { err });
    res.status(503).json({ error: "Database unreachable" });
  }
});

/**
 * Push ingest. The scriptable way in: POST text and it goes through the same dedupe → extract →
 * transactional merge path the folder connector uses, so pushes and polls can't corrupt each
 * other.
 *
 * Requires an existing `http` Source, which is what binds the push to a book and gives the
 * dedupe ledger something to key against.
 */
app.post("/ingest", async (req, res) => {
  const { sourceId, externalId, content, title } = req.body ?? {};
  if (typeof sourceId !== "string" || typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "sourceId and non-empty content are required" });
    return;
  }

  try {
    const source = await db.source.findUnique({ where: { id: sourceId } });
    if (!source || source.userId !== env.OWNER_ID) {
      res.status(404).json({ error: "Source not found" });
      return;
    }

    const settings = await getSettings(db);
    const result = await ingestDocuments(
      db,
      source.userId,
      source.worldId,
      source.id,
      // Without a caller-supplied id, key on the content hash so the same payload pushed twice
      // dedupes instead of accumulating duplicate ledger rows.
      [{ externalId: externalId ?? `push:${createHash("sha256").update(content).digest("hex")}`, content, title }],
      { llmRouter: settings.llmRouter, llmModel: settings.llmModel ?? "gpt-4o-mini" },
    );

    res.json(result);
  } catch (err) {
    logger.error("Ingest failed", { err });
    res.status(500).json({ error: "Ingest failed" });
  }
});

// Settings UI. Registered last so it can never shadow an API or MCP route.
app.get("/", (_req, res) => {
  res.type("html").send(SETTINGS_PAGE);
});

// Background connector polling. Config is resolved per tick so a settings change takes effect
// without a restart.
const syncWorker = startSyncWorker(db, {
  getConfig: async () => {
    const s = await getSettings(db);
    return { llmRouter: s.llmRouter, llmModel: s.llmModel ?? "gpt-4o-mini" };
  },
});

const server = app.listen(env.PORT, () => {
  // Log the bound port, not APP_URL's — they differ when PORT is overridden, and a startup line
  // that names the wrong port sends you debugging the wrong thing.
  logger.info("worldbrain listening", { port: env.PORT, mcp: `http://localhost:${env.PORT}/mcp` });
});

/**
 * Dokploy/Docker send SIGTERM on redeploy. Draining in-flight requests before disconnecting
 * Prisma avoids tearing down a connection mid-transaction — which for the checkpoint write path
 * would abort a merge that a client believes succeeded.
 */
async function shutdown(signal: string) {
  logger.info("Shutting down", { signal });
  // Stop polling first: starting a fresh ingest pass while the process is going down would
  // leave a document half-merged and its ledger row unwritten.
  syncWorker.stop();
  server.close(async () => {
    await db.$disconnect();
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
