# worldbrain

A self-hosted **shared context store for AI tools**. One book per project, served over MCP, so
Claude Code, Hermes, Cursor and anything else MCP-speaking all read *and write* the same memory.

The problem it solves: every AI tool remembers in its own silo. Work through an architecture
decision in one, pick the task up in another next week, and the second agent starts from nothing.
worldbrain is the substrate underneath them — an agent records a decision here, and every other
tool sees it.

Built on a structured, self-updating retrieval engine extracted from the Aria project and
retargeted for project context. See [`docs/01_architecture.md`](docs/01_architecture.md) for the
design and its reasoning.

## How it works

```
  Claude Code ─┐
  Hermes       ├─ MCP ──▶  worldbrain  ──▶  Postgres + pgvector
  Cursor      ─┘            (container)
                                ▲
                    folder watch / POST /ingest
```

An agent calls `world_context` before starting work and gets what's already established. It calls
`world_remember` when it learns something durable. Extraction structures the prose into entities,
relationships and a decision log; retrieval hands the relevant slice back to whichever tool asks
next.

## MCP tools

| Tool | What it does |
|---|---|
| `world_context(text)` | **The main one.** Pass the user's request; returns everything relevant across all books by matching names and tags literally. No embedding call, so it's cheap enough to call every time. |
| `world_search(query)` | Semantic search — vector similarity blended with importance and recency, plus exact-name recall. |
| `world_entity(name)` | One entity's full card. Resolves aliases, so informal names still hit. |
| `world_chronology(worldId)` | The decision log, plus a condensed breadcrumb of older entries. |
| `world_summary(worldId)` | Summary, current focus and core entities. |
| `world_remember(worldId, text)` | **The write.** Describe what you learned in prose; it gets extracted and merged. |
| `world_create(title, tags)` | Create a book. Tags are the trigger words `world_context` matches on. |
| `worlds_list()` | Books with tags and entity counts. |

## Quick start

```bash
cp .env.example .env        # set POSTGRES_PASSWORD and an API key
docker compose up -d        # Postgres + pgvector, then the app
```

Then open `http://localhost:8080` for settings, and point an MCP client at
`http://localhost:8080/mcp`.

For Claude Desktop or Cursor, which spawn a process rather than dialling a URL:

```json
{
  "mcpServers": {
    "worldbrain": {
      "command": "npx",
      "args": ["-y", "worldbrain-stdio"],
      "env": { "WORLDBRAIN_URL": "http://worldbrain.your-tailnet.ts.net:8080" }
    }
  }
}
```

### Deploying to Dokploy

Use a **Docker Compose** service type (Stack/Swarm can't `build:`). Set the variables from
`.env.example` in Dokploy's Environment tab — they are not auto-injected, which is why the compose
file references each one explicitly. Point the Domains tab at the `app` service, port 8080, rather
than hand-writing Traefik labels.

### Access over Tailscale (no public domain)

worldbrain has **no authentication** — it trusts its network boundary — so it must never be
exposed on a public interface. The private-network pattern:

1. The compose file publishes the app to `127.0.0.1:8080` only, so it's reachable on the server's
   loopback but not its public IP.
2. On the server, expose that port to your tailnet with HTTPS:
   ```bash
   tailscale serve --bg 8080
   ```
   It becomes reachable at `https://<server>.<tailnet>.ts.net` from any device on your tailnet,
   and nowhere else. `tailscale serve status` shows the URL.
3. Set `APP_URL` to that URL, and point MCP clients at `https://<server>.<tailnet>.ts.net/mcp`.

The tailnet is the auth boundary, which is exactly what makes the no-auth design safe. Do **not**
publish the port on `0.0.0.0` or forward it through a public domain without adding auth first.

### Local development

```bash
npm install
npm run db:generate
docker compose up -d db     # Postgres alone is enough for the tests
npm run db:migrate
npm run dev
```

## Ingest

Content gets in three ways:

- **`world_remember`** over MCP — an agent records what it learned.
- **Folder** — a `Source` of type `folder` polls a mounted directory; drop in `.md`/`.txt` and it
  becomes part of the book.
- **`POST /ingest`** — push text directly, for scripting.

All three converge on the same path: content-hash dedupe → chunk → extract → transactional merge.
Re-ingesting unchanged content is free.

## Architecture notes

- **Every write is a delta applied under a row lock.** `applyDeltaTransactional` is the only
  sanctioned write path — several agents writing one book concurrently is the normal case, and an
  unguarded read-modify-write loses entities *silently*, since the merge engine never deletes.
- **Retrieval is hybrid.** Vector similarity + importance + recency, augmented by exact-name (DCI)
  matching, which catches proper nouns whose embeddings are weak.
- **Books can be tag-gated** — silent until one of their tags is explicitly named. Useful for a
  book of conventions that shouldn't bleed into unrelated work.
- **Bounded memory.** Chronology rolls up into a compact archive and cold entities go dormant, so a
  book that accumulates for years stays a usable size.
- **`readOnly`** locks a book against agent writes. Default false — the premise is that any
  connected tool contributes.

## Layout

| Area | Files | What it does |
|---|---|---|
| **MCP + HTTP** | `server/mcp.ts`, `server/index.ts` | Tool surface, streamable HTTP, settings UI, `/ingest` |
| **Write path** | `services/world/worldWrite.ts` | Row-locked read-merge-write. The only way to mutate a book |
| **Retrieval** | `services/embedding/vectorSearch.ts` | pgvector hybrid search, tag-gated search |
| **DCI** | `services/world/dciSearch.ts` | Exact-name recall, alias and word-boundary matching |
| **Merge** | `services/world/merge.ts` | Delta application, fuzzy dedup, tombstone protection |
| **Lifecycle** | `services/world/lifecycle.ts` | Recency stamping, chronology rollup, dormancy |
| **Ingest** | `services/ingest/*` | Connectors, dedupe, chunking, sync worker |
| **Extraction** | `services/intelligence/*`, `services/prompt/constants.ts` | Prose → structured delta |

`src/index.ts` exports the engine for use as a library.

## Requirements

PostgreSQL with **pgvector** — embeddings live in `vector(1024)` columns, and a stock `postgres`
image will fail on every write. The compose file uses `pgvector/pgvector:pg17`.

The embedding model must produce **1024 dimensions**. Changing families later means a column
migration and a full re-embed; there's no backfill job yet, so switching silently strips older rows
from results (they're filtered by `embeddingModel` at query time).

## Status

Working and typechecked, with 66 passing tests. **Not yet verified against a live database or a
real model** — the concurrency tests skip without `DATABASE_URL`, and extraction quality is
unmeasured. Both are the first things to check after deploying.
