---
audience: internal
rag_include: false
status: forward_design
reason: "Forward-looking plan to expose the lorebook as an MCP context layer (a self-made Unabyss). Not implemented yet."
---

# Lorebook as a Self-Made "Unabyss" — MCP Context Layer (Plan)

## 1. Vision

The lorebook system is already a self-updating, structured, relevance-ranked **narrative memory**:
it ingests (Librarian extraction), structures + tags (entities, chronology, tags, importance,
aliases, exposure logs), retrieves the relevant slice (RAG + DCI + tag-gating), and self-updates
(the extraction/merge/rollup lifecycle).

The one missing layer — the thing [Unabyss](https://unabyss.com/) sells — is **serving that memory
over MCP** so any MCP-compatible client (Claude Desktop, Cursor, another RP frontend) can query a
user's accumulated world(s). Goal: *connect once, every AI reads the same world-brain.* A "self-made
Unabyss," specialized for narrative worlds instead of work tools.

## 2. Guiding principles

- **Reuse, don't rebuild.** The MCP server is a thin protocol adapter over the existing service
  layer; the hard part (structured self-updating retrieval) is done.
- **Read-first.** Serving is safe. Writing over MCP reopens the concurrency/merge concerns we just
  hardened, so defer it.
- **Scope per-user / per-world.** Reuse the ownership checks already in `lorebookService`.
- **Self-host friendly.** A local per-user MCP server sidesteps multi-tenant auth/encryption — that
  burden is Unabyss's business model, not ours.

## 3. Architecture

- **New surface:** `apps/mcp` (or an MCP mode of `apps/api`) — an MCP server (stdio first, optional
  HTTP/SSE later) that imports the existing service layer + Prisma client. No new data store.
- **Calls the same functions the pipeline uses** (this is the whole point):
  - Retrieval: `hybridLorebookSearch`, `dciLookupByNames` / `dciAugmentRetrievedItems`,
    `tagGatedLorebookSearch` (with the new `tagAppearsInText`).
  - Structure: `lorebookService` (`list` / `get` / `getIndexedItems` / `getCheckpoints`).
  - Query embedding: `embedText` with the user's embedding router/model from Settings (same as
    `buildPrompt`).
- **Auth:** a per-user MCP token → `userId`. Every tool call is scoped to that user's lorebooks,
  mirroring `lorebookService`'s existing ownership guard. Reuse the BYOK `apiKey` infra or a small
  dedicated MCP-token table.

## 4. MCP tool surface (M1, read-only)

Each returns structured JSON **and** a compact text rendering, so a client LLM can consume either.

| Tool | Maps to | Notes |
|---|---|---|
| `worlds.list()` | `lorebookService.list` | id, title, tags, group, updatedAt, entity counts |
| `world.entity(worldId, name)` | `dciLookupByNames` | exact-name card; resolves **aliases** so nicknames work |
| `world.search(worldId?, query, limit)` | `embedText` → `hybridLorebookSearch` + `dciAugmentRetrievedItems` | ranked hits tagged `source: vector\|tag\|dci` |
| `world.chronology(worldId, {limit})` | checkpoint `chronology` + `chronology_archive` | recent beats + condensed older breadcrumb |
| `world.summary(worldId)` | checkpoint `summary` + `scene` + core cast | macro continuity |
| `world.related(worldId, name, hops=1)` | entity `relationships` map → `dciLookupByNames` | 1-hop expansion — the "connect stuff" primitive |
| `world.tags(worldId)` *(opt)* | tag index | for tag-gated retrieval clients |

**Optional MCP resources:** expose worlds as `world://{id}/entity/{name}` for clients that prefer
resource browsing over tool calls.

**Deliberately NOT applied over MCP:** the dormancy/core-floor budget filter and the prompt-size
caps — those are *generation-prompt* concerns. MCP returns the full relevant slice; the client
decides what to use.

## 5. Retrieval reuse details

- **Query embedding** needs the user's embedding router/model (from Settings), same as
  `buildPrompt`. Cache the client per token.
- **Canon gating:** optional `canonPosition` param (book/chapter) → `hybridLorebookSearch`, reusing
  the existing temporal gate.
- **Discovered vs. tag-gated references** behave as they do in-pipeline: tag-gated worlds require a
  tag hit; discovered references use vector RAG.

## 6. Phasing

- **M1 — Read-only server (MVP, ~80% of the value).** `worlds.list`, `world.entity`, `world.search`,
  `world.chronology`, `world.summary`. Local stdio MCP server, per-user token, retrieval reused
  verbatim. This makes any AI able to query the world-brain — the core Unabyss promise.
- **M2 — Connections *in* (client direction).** Generalize `GraphLorebookRef` so a "reference" can be
  an **external MCP endpoint** (a canon wiki, a shared community world, another user's export). DCI /
  tag layer routes; needs a connector abstraction + sync cadence. This is the "allows stuff to
  connect" half.
- **M3 — Write over MCP (careful).** `world.propose(worldId, delta)` → runs through `applyLorebookDelta`
  + the **transactional row-locked write** we hardened (same death-tracking / tombstone / fixedContent
  protections). Validated, gated, rate-limited. Only after M1/M2 prove out.
- **M4 — Cross-world graph.** Worlds link to worlds (recursive inheritance generalized); a query can
  traverse linked worlds (multi-hop retrieval).

## 7. Non-goals (for now)

- Multi-tenant SaaS hosting / encrypted multi-tenant storage (self-host avoids it).
- Ingesting non-narrative tools (Slack/Gmail/etc.) — the value here is *worlds*, not work context.
- Real-time bidirectional sync.

## 8. Open decisions

- **Host model:** separate `apps/mcp` process vs. an MCP mode of `apps/api`. Separate is cleaner;
  both share the service layer.
- **Transport:** stdio (local, Claude Desktop) first; HTTP/SSE for remote clients later.
- **Token model:** reuse BYOK `apiKey` infra vs. a new MCP-token table.
- **Read/write boundary:** M1 read-only; writes deferred to M3 behind the hardened merge path.
- **Embedding cost:** MCP `world.search` embeds queries — billed to the user's embedding key/budget.

## 9. Risks

- **Data egress surface:** exposing world data outside Aria is a new boundary → auth must be tight
  and per-world scoped from day one.
- **Write path (M3)** must go through the same hardened transactional merge, or concurrent external
  writers corrupt checkpoints — exactly the failure mode we just fixed internally.
- **Embedding key/cost** per MCP query needs an owner and a cap.

## 10. Effort sketch

- **M1:** moderate. Retrieval exists; the work is the MCP server scaffold (SDK), token→user auth, tool
  schemas, and JSON/text rendering. Days, not weeks.
- **M2/M3/M4:** larger — connector abstraction, write safety, graph traversal.

---

> The lorebook is already the structured, self-updating, relevance-ranked store Unabyss charges for.
> This plan is just the **serving protocol** on top — MCP-native, per-world scoped, read-first.
