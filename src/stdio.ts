#!/usr/bin/env node
/**
 * worldbrain-stdio — a stdio ⇄ HTTP bridge.
 *
 * worldbrain runs as a background container and serves MCP over HTTP. Some clients (Claude
 * Desktop, Cursor) don't dial a URL — they spawn a process and speak JSON-RPC over its stdin and
 * stdout. This binary is that process: it forwards each request to the daemon's /mcp endpoint and
 * writes the response back to stdout.
 *
 * It holds no state and imports none of the engine, so it stays usable on a laptop that has no
 * database access — it only needs to be able to reach the daemon (over Tailscale, typically).
 *
 * Usage in a client's MCP config:
 *
 *   {
 *     "mcpServers": {
 *       "worldbrain": {
 *         "command": "npx",
 *         "args": ["-y", "worldbrain-stdio"],
 *         "env": { "WORLDBRAIN_URL": "http://worldbrain.your-tailnet.ts.net:8080" }
 *       }
 *     }
 *   }
 */

const BASE_URL = (process.env.WORLDBRAIN_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const MCP_URL = `${BASE_URL}/mcp`;

/** Anything written to stdout must be protocol traffic, so diagnostics go to stderr. */
function log(msg: string, extra?: unknown) {
  process.stderr.write(`[worldbrain-stdio] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`);
}

/**
 * Forwards one JSON-RPC message and returns the response, or null for a notification.
 *
 * The daemon answers with either application/json or an SSE stream depending on the request, so
 * both are handled: an SSE body is unwrapped down to its `data:` payload.
 */
async function forward(message: unknown): Promise<unknown | null> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Advertise both so the daemon may answer either way.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(message),
  });

  // 202 Accepted with no body is the correct response to a notification.
  if (res.status === 202) return null;

  const text = await res.text();
  if (!text.trim()) return null;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);

  // SSE frames: keep the last `data:` payload, which carries the JSON-RPC response.
  let payload: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) payload = line.slice(5).trim();
  }
  return payload ? JSON.parse(payload) : null;
}

/**
 * Reads newline-delimited JSON-RPC from stdin.
 *
 * Buffering is required: stdin arrives in arbitrary chunks, so a single message can be split
 * across two reads and two messages can share one. Splitting on newline and retaining the
 * trailing partial line is what keeps a large tool result from being truncated mid-object.
 */
let buffer = "";

/**
 * In-flight forwards. stdin closing does NOT mean the work is done: a piped or short-lived client
 * closes stdin the moment it has written its last request, and exiting there discards responses
 * that are still in flight. Tracked so shutdown can wait for them.
 */
const pending = new Set<Promise<void>>();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;

  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;

    let message: { id?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      log("Ignoring unparseable line from client");
      continue;
    }

    // Not awaited: requests are handled concurrently, matching MCP's model where a client may have
    // several in flight. Ordering is preserved by the `id` in each response.
    const task = (async () => {
      try {
        const response = await forward(message);
        if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (err) {
        log("Request failed", { err: String(err) });
        // Only a request (something with an id) can be answered; a failed notification has
        // nowhere to report to, and inventing an id would confuse the client.
        if (message.id !== undefined) {
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: `Cannot reach worldbrain at ${MCP_URL}: ${String(err)}` },
            })}\n`,
          );
        }
      }
    })();

    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
});

// Drain before exiting — see `pending`. Without this, piping input in exits mid-request and the
// responses are silently lost.
process.stdin.on("end", async () => {
  while (pending.size > 0) await Promise.allSettled([...pending]);
  process.exit(0);
});

log(`Bridging stdio to ${MCP_URL}`);
