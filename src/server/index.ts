import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PrismaClient } from "@prisma/client";
import express from "express";
import { env } from "../env.js";
import { createLogger } from "../utils/logger.js";
import { createMcpServer } from "./mcp.js";
import { getSettings, updateSettings } from "./settings.js";

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
  server.close(async () => {
    await db.$disconnect();
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
