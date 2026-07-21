# worldbrain

A self-hosted, embeddings-backed, **MCP-native persistent context store** — a custom "Abyss."
It's the world framework extracted from Aria, un-coupled from the chat app and repurposed as a
standalone engine: ingest → structure/tag → self-update → retrieve the relevant slice → serve.

See [`docs/00_plan.md`](docs/00_plan.md) for the vision and phased roadmap.

## What's in here (the engine)

| Area | Files | What it does |
|---|---|---|
| **Retrieval** | `services/embedding/vectorSearch.ts` | pgvector hybrid search (similarity + importance + recency), tag-gated search |
| **DCI** | `services/world/dciSearch.ts` | exact-name recall, alias/nickname + word-boundary matching, mention detection |
| **Merge** | `services/world/merge.ts` | delta application, fuzzy dedup, death/tombstone/fixedContent protection |
| **Lifecycle** | `services/world/lifecycle.ts` | recency stamping, chronology rollup, entity dormancy (bounded working memory) |
| **Sync** | `services/world/itemSync.ts`, `passageSync.ts` | checkpoint → relational items + embeddings; passage chunking |
| **Ingest** | `services/intelligence/*` | LLM extraction of a structured delta from raw input (self-updating) |
| **LLM client** | `services/llm/routerDispatch.ts` | minimal OpenAI-compatible chat client (OpenAI / OpenRouter / nanoGPT / custom) |
| **Worlds** | `services/world/worldService.ts` | standalone world CRUD (no chat/graph coupling) |

Everything is exported from `src/index.ts`.

## Not yet built (next phases, per the plan)

- **MCP server** exposing `world.search / world.entity / world.chronology / world.summary` (M1, read-only).
- **Hosting** (HTTP/SSE transport, per-user token → `userId` auth).
- **Connectors in** (external MCP sources as references) and **write-over-MCP** (through the hardened merge).

## Setup

```bash
npm install
cp .env.example .env      # set DATABASE_URL + an LLM/embedding key
npm run db:generate
npm run db:push           # or db:migrate once migrations exist
npm run typecheck
npm test
```

Requires **PostgreSQL with the `pgvector` extension** (embeddings live in `vector(1024)` columns).
The HNSW vector indexes + `lower(key)` functional index need a raw-SQL migration (see the Aria
`add_vector_indexes` migration for the exact DDL to port).

## Provenance

Ported from the Aria world subsystem. The retrieval/merge/lifecycle/ingest logic is the same,
battle-tested code; only the app coupling (personas, chat pipeline, Director, group chat, BYOK
routing, prompt system) was stripped and replaced with a minimal, neutral boundary layer.
