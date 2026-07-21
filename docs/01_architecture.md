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

**BUILT** — `services/world/worldWrite.ts`. Recorded here because the reasoning matters more than
the code: this was the highest-priority piece of work, and the bug it fixes is invisible.

`00_plan.md` §6 assumed writes go through "`applyLorebookDelta` + the transactional row-locked write
we hardened." Only the first half was ported. What existed before this work:

- `applyLorebookDelta` (now `applyDelta`) — a **pure** function: `(checkpoint, delta) => checkpoint`.
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
*composition* is what breaks. Those tests exist in `worldWrite.test.ts` but **skip without
`DATABASE_URL` and have never been executed** — see §10.

`readOnly` is enforced in the same transaction, read from the locked row. It was `isReference` when
ported, where Aria's check lived in the stripped chat pipeline — leaving a column that was written,
never read, and silently protected nothing.

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

Added (BUILT, in `server/mcp.ts`):

| Tool | Maps to | Notes |
|---|---|---|
| `world_context(text)` | tag-gated + DCI mention matching | Not in the original plan, and now the most important tool. See below. |
| `world_remember(worldId, text)` | extract → `applyDeltaTransactional` | The write. An agent states what it learned in prose; the extractor structures it. |
| `world_create(title, tags)` | `worldService.create` | Books were previously uncreatable except by writing to the database directly. |

`world_remember` takes prose rather than a delta deliberately. Asking a client LLM to hand-author a
schema-valid delta spends its attention on schema compliance; letting it narrate and running the
existing extraction pass over that text reuses a pipeline already tuned for the job.

`world_context` is the per-project-book primitive: pass the user's request and it matches names and
tags literally across every book, returning what is already known. It needs no embedding call, so
it is cheap enough for an agent to call before every task — which is what makes "any mention pulls
the right book in" work in practice.

**The pull-based constraint.** MCP servers cannot inject context; they only answer when a client
chooses to call. So "a mention automatically triggers a lookup" is approximated three ways: a cheap
`world_context` tool, server `instructions` and tool descriptions that tell the agent to call it
first, and (for genuine automation) a client-side hook such as Claude Code's `UserPromptSubmit`.
Only the third is truly automatic, and it is client configuration rather than server code.

**Write safety:** every write is validated against the extraction schema and passes through the same
tombstone / `fixedContent` protections as internal writes — those live inside the merge, so routing
all writes through one path gets them for free. Rate limiting is not yet implemented.

## 5. Ingest — the connector model  *(BUILT — `services/ingest/`)*

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
- **Ledger written only after success** — writing it first would mark a failed extraction as
  done and never retry it.
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

The engine is no longer world-specific. Renaming before the first migration exists, while it is
free:

| Current | New |
|---|---|
| `World` / `worlds` | `World` / `worlds` |
| `WorldItem` / `world_items` | `WorldItem` / `world_items` |
| `WorldCheckpoint` / `world_checkpoints` | `WorldCheckpoint` / `world_checkpoints` |
| `worldId` | `worldId` |
| `passage` item type | `passage` |
| `services/world/` | `services/world/` |
| `applyDelta` | `applyDelta` |
| `hybridSearch` | `hybridSearch` |
| "Librarian" (comments) | "extractor" |

`Memory` keeps its name. DCI keeps its name — it is a specific retrieval technique, not narrative
jargon.

## 8. Order of work

1. ~~**Transactional write path** (§2)~~ — done, `worldWrite.ts`. Concurrency tests written but
   never executed (§10).
2. ~~**Rename** (§7)~~ — done.
3. ~~**MCP server**~~ — done: streamable HTTP, read tools, `world_context`, `world_remember`.
4. ~~**stdio shim**~~ — done, `src/stdio.ts`, published as `worldbrain-stdio`.
5. ~~**Connectors**~~ — done: folder + http push over a shared dedupe/chunk/merge pipeline.
6. ~~**Settings UI + Docker + migrations**~~ — done, including the HNSW and `lower(key)` indexes.
7. **Verify against a live database and a real model** — the only remaining step, and the one that
   matters most (§10).

### Also retargeted from Aria

The engine assumed roleplay. Three things were not merely cosmetic:

- The extraction prompt was a narrative-fiction directive; given a paragraph about database choice
  it modelled the codebase as story characters. Rewritten for project context.
- The `entity_type` mapping matched only narrative vocabulary, so technical words fell through to a
  single bucket. It fails *silently* — a missing alias does not error.
- An anti-self-echo penalty docked 0.25 from anything under 90 minutes old, so a roleplay model
  would not echo its own output. Here it suppressed exactly the recent-decision hand-off the system
  exists for. Removed.

Death tracking, `exposure_tags`, persona/chat scoping and the `memoryScope` query branch were
removed. Dormancy and tombstones were kept: both earn their place in a book that accumulates for
years.

## 9. Known gaps

- **`EMBEDDING_DIM` is hardcoded to 1024** and the pgvector column is `vector(1024)`. Switching
  embedding model families in the UI is therefore not actually safe — changing dimension requires a
  column migration and a full re-embed. The UI must either constrain choices to 1024-dim models or
  own that re-embed flow explicitly.
- **Cross-model embedding contamination** is guarded at query time (`embeddingModel` filter) but
  there is no backfill/re-embed job, so switching models silently strips old rows from results.
- **No rate limiting on writes.** A misbehaving agent could hammer `world_remember` and burn the
  extraction budget.
- **`world_related` and `world_tags`** from `00_plan.md` §4 are not implemented.
- **M2/M4** — external MCP endpoints as connectors, and cross-world graph traversal — remain
  unstarted.

## 10. What has and has not been verified

Being explicit, because the gap is easy to lose track of.

**Verified:** typecheck and build clean; 66 unit tests pass; MCP `initialize` and `tools/list`
answer correctly over HTTP; the stdio bridge proxies all 8 tools and errors properly when the
daemon is unreachable; the settings UI serves and degrades correctly without a database.

**Not verified — nothing has touched a real database or a real model:**

1. **The concurrency tests have never run.** `SELECT ... FOR UPDATE` semantics need a live
   Postgres, and the environment this was built in had neither Docker nor Postgres. The row-locked
   write path is load-bearing for every write, and it is unproven.
2. **No tool body has executed.** Every tool typechecks; none has run a query.
3. **Extraction quality is unmeasured.** The new prompt is plausible but unvalidated, and a prompt
   that reads well while extracting poorly is precisely the failure that survives review. It needs
   a real paragraph about a real project, with the resulting buckets inspected by hand.
4. **The folder connector has never polled a real directory.**

First run after deploying should be `npm run db:migrate && npm test` with `DATABASE_URL` set, then a
manual `world_remember` with real prose.
