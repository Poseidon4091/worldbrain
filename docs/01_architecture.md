---
audience: internal
rag_include: false
status: forward_design
supersedes_scope_of: 00_plan.md
reason: "Revised target: a self-hosted background daemon serving one shared context brain over MCP, with writes as a first-class goal. Supersedes the scope (not the retrieval design) of 00_plan.md."
---

# worldbrain — Architecture

## 1. What this is

A **self-hosted background service** that holds one persistent, self-updating context store and
serves it over MCP, so every AI tool you use reads and writes the *same* brain.

The motivating scenario: work through something in Claude Code, pick it up later in Hermes, and the
second agent already knows what was done and how. Today each tool's memory is a silo; worldbrain is
the shared substrate underneath them.

This supersedes the *scope* of [`00_plan.md`](00_plan.md) — the retrieval design there still stands.
Four things changed:

| `00_plan.md` | Now | Why |
|---|---|---|
| stdio MCP server | HTTP/SSE daemon + stdio shim | A stdio server is spawned per client; that contradicts "runs in the background." |
| Read-only M1, writes deferred to M3 | **Writes are a primary goal** | Shared context only accumulates if every tool can contribute. |
| A library | Docker container + settings UI | Hands-off operation. |
| Nothing feeds it | Connector pull-sync loop | The ingest pipeline existed but had no trigger. |
| Lorebook / RP naming | worldbrain-neutral naming | No longer narrative-specific. |

Deployment target: single user, no auth, bound to localhost or a trusted LAN. Models come from
OpenRouter / OpenAI / any OpenAI-compatible endpoint, configured in the UI.

## 2. The correctness foundation: transactional writes

**This is the highest-priority piece of work, and it does not currently exist.**

`00_plan.md` §6 assumes writes go through "`applyLorebookDelta` + the transactional row-locked write
we hardened." Only the first half was ported. What exists today:

- `applyLorebookDelta` — a **pure** function: `(checkpoint, delta) => checkpoint`.
- `worldService.saveCheckpoint` — a **plain, unguarded** `UPDATE`.

Nothing composes read → merge → write atomically. The resulting lost-update race:

```
Writer A (Claude Code)          Writer B (Hermes)
──────────────────────          ─────────────────
read checkpoint v1
                                read checkpoint v1
merge delta A  → v2a
                                merge delta B  → v2b
write v2a
                                write v2b        ← A's entities are gone
```

This fails **silently**. The merge engine never deletes, so no error surfaces and no tombstone is
written — entities simply stop existing. With multiple agents writing concurrently (the entire point
of the system) this is not a rare edge case.

### The fix

A single `applyDeltaTransactional(db, worldId, delta)` that is the *only* sanctioned write path:

```
BEGIN
  SELECT checkpoint FROM worlds WHERE id = $1 FOR UPDATE   -- serializes concurrent writers
  merged := applyDelta(checkpoint, delta)                  -- existing pure merge
  UPDATE worlds SET checkpoint = merged WHERE id = $1
  INSERT INTO world_checkpoints (...)                      -- audit snapshot
COMMIT
then (outside the tx): sync items + embed                  -- slow, network-bound, retryable
```

Design notes:

- **Row lock, not optimistic retry.** Deltas are small and writes are infrequent; blocking briefly is
  simpler and has no lost-update window. A `statement_timeout` guards against a stuck writer.
- **Embedding stays outside the transaction.** It is network-bound and slow; holding a row lock
  across an HTTP call to OpenAI would serialize the whole system on provider latency.
- **`saveCheckpoint` becomes internal.** Exposing a blind full-checkpoint overwrite alongside a safe
  merge path invites callers to reintroduce the race. Writers submit *deltas*.

Test coverage must include an actual concurrency test (two interleaved transactions against a real
Postgres), not just a unit test of the merge function — the merge is already correct; the
*composition* is what breaks.

## 3. Processes

```
┌──────────────────────────────────────────────┐
│ worldbrain container                         │
│                                              │
│  HTTP server                                 │
│   ├─ /mcp        MCP over streamable HTTP    │  ← Claude Code, Hermes, Cursor
│   ├─ /ingest     push text in                │
│   └─ /           settings UI                 │
│                                              │
│  Sync worker (in-process, interval-driven)   │
│   └─ poll sources → extract → merge → embed  │
│                                              │
│  Engine (existing services/)                 │
└──────────────────────────────────────────────┘
                      │
              ┌───────────────┐
              │ Postgres      │
              │ + pgvector    │
              └───────────────┘

  worldbrain-stdio  ← separate tiny binary, proxies stdio ⇄ /mcp
                      for clients that only spawn processes
```

One container, one process. The sync worker runs in-process on a timer — a separate queue/worker
tier is unjustified at single-user scale and can be split out later if it ever blocks the event loop.

## 4. MCP surface

Read tools are as specified in `00_plan.md` §4 (`worlds.list`, `world.entity`, `world.search`,
`world.chronology`, `world.summary`, `world.related`, `world.tags`) — that design is unchanged, and
the deliberate omission of the dormancy/budget filter still applies: MCP returns the full relevant
slice and the client decides what to use.

Added, and gated on §2 landing first:

| Tool | Maps to | Notes |
|---|---|---|
| `world.remember(worldId, text)` | extract → `applyDeltaTransactional` | The natural write. An agent states what it learned in prose; the extractor structures it. |
| `world.propose(worldId, delta)` | `applyDeltaTransactional` | Structured write for callers that already have a delta. |

`world.remember` is the important one. Asking a client LLM to hand-author a valid delta wastes its
attention on schema compliance; letting it narrate and running the existing extraction pass over that
text reuses the pipeline that is already tuned for exactly this job.

**Write safety:** every write is validated against the extraction schema, rate-limited, and passes
through the same death-tracking / tombstone / `fixedContent` protections as internal writes — those
live inside the merge, so routing all writes through one path gets them for free.

## 5. Ingest — the connector model

Unabyss's approach is **connector pull-sync**: it connects to the tools where data already lives,
pulls, extracts, structures, and re-syncs as those sources change. The client AI only ever reads.
worldbrain uses the same architecture with different connectors — `00_plan.md` §7 rules out
Slack/Gmail-style work-tool ingestion, so the sources here are documents and transcripts.

A `Source` row describes something to watch:

| Type | Behavior |
|---|---|
| `folder` | Watch a mounted directory. New/changed files → chunk → extract → merge. |
| `http` | Content pushed to `/ingest` (scriptable; wire up anything). |
| `mcp` | *(later)* A remote MCP endpoint as a read-through reference — this is `00_plan.md`'s M2. |

Common machinery for all connectors, so a new one is a small adapter:

- **Content-hash dedupe** — re-syncing an unchanged file must be a no-op, or every poll re-extracts
  and burns tokens.
- **Watermark per source** — only new content is processed.
- **Extract → merge** through the §2 transactional path, same as MCP writes.
- **Failure isolation** — one broken source must never stall the others.

Note that writes over MCP and connector ingest converge on the same merge path, which is what makes
them safe to run concurrently.

## 6. Configuration

`Settings` is a worldbrain-owned model (added to the schema; *not* a port of Aria's), seeded from env
on first boot and editable in the UI: embedding provider/model, ingest LLM provider/model, sync
interval. Env supplies defaults and secrets; the DB row is the live value, so retuning the daemon
does not require a redeploy.

API keys stay in env only — a settings UI with no auth must never render them back.

## 7. Naming

The engine is no longer lorebook-specific. Renaming before the first migration exists, while it is
free:

| Current | New |
|---|---|
| `Lorebook` / `lorebooks` | `World` / `worlds` |
| `LorebookItem` / `lorebook_items` | `WorldItem` / `world_items` |
| `LorebookCheckpoint` / `lorebook_checkpoints` | `WorldCheckpoint` / `world_checkpoints` |
| `lorebookId` | `worldId` |
| `rp_passage` item type | `passage` |
| `services/lorebook/` | `services/world/` |
| `applyLorebookDelta` | `applyDelta` |
| `hybridLorebookSearch` | `hybridSearch` |
| "Librarian" (comments) | "extractor" |

`Memory` keeps its name. DCI keeps its name — it is a specific retrieval technique, not narrative
jargon.

## 8. Order of work

1. **Transactional write path** (§2) + a real concurrency test. Everything else writes through it.
2. **Rename** (§7). Free now; expensive after migrations and more code exist.
3. **MCP server** — HTTP/SSE, read tools, then `world.remember`.
4. **stdio shim** — Claude Desktop / Cursor compatibility.
5. **Connectors** — folder + http, with the shared dedupe/watermark machinery.
6. **Settings UI + Docker** — compose file with pgvector, plus the raw-SQL migration for the HNSW
   indexes and the `lower(key)` functional index (see README).

## 9. Known gaps

- **No migrations exist.** `db push` only. The HNSW vector indexes and the `lower(key)` functional
  index that DCI's exact-match lookup depends on need hand-written SQL; without them both retrieval
  paths degrade to sequential scans.
- **`EMBEDDING_DIM` is hardcoded to 1024** and the pgvector column is `vector(1024)`. Switching
  embedding model families in the UI is therefore not actually safe — changing dimension requires a
  column migration and a full re-embed. The UI must either constrain choices to 1024-dim models or
  own that re-embed flow explicitly.
- **Cross-model embedding contamination** is guarded at query time (`embeddingModel` filter) but
  there is no backfill/re-embed job, so switching models silently strips old rows from results.
