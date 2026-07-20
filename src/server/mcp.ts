import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { env } from "../env.js";
import { embedText } from "../services/embedding/index.js";
import { hybridLorebookSearch, type SimilarLorebookItem } from "../services/embedding/vectorSearch.js";
import { extractNarrativeDelta } from "../services/intelligence/narrativeIntelligence.js";
import { dciLookupByNames } from "../services/lorebook/lorebookDciSearch.js";
import type { LorebookCheckpoint, LorebookDelta } from "../services/lorebook/lorebookMerge.js";
import { createWorldService } from "../services/lorebook/worldService.js";
import { applyDeltaTransactional } from "../services/lorebook/worldWrite.js";
import type { RouterType } from "../services/llm/routerDispatch.js";
import { createLogger } from "../utils/logger.js";
import { getSettings } from "./settings.js";

const logger = createLogger("mcp");

/**
 * The MCP tool surface — the point of the whole system: every client (Claude Code, Hermes, Cursor)
 * talks to the same brain through these.
 *
 * Each tool returns BOTH a compact text rendering and `structuredContent`, so a client LLM can
 * read the prose while a programmatic caller gets the JSON.
 *
 * Note what is deliberately NOT applied here (per docs/00_plan.md §4): the dormancy/core-floor
 * budget filter and prompt-size caps are *generation-prompt* concerns. MCP returns the full
 * relevant slice and lets the client decide what to spend context on.
 */

/** Text rendering of a retrieved item. Content is stored as JSON by the item sync. */
function renderItem(item: { key: string; type: string; content: string }): string {
  try {
    const parsed = JSON.parse(item.content);
    const bits = [
      parsed.blurb,
      parsed.traits?.length ? `Traits: ${parsed.traits.join(", ")}` : null,
      parsed.status ? `Status: ${parsed.status}` : null,
      parsed.relationships && Object.keys(parsed.relationships).length
        ? `Relationships: ${Object.entries(parsed.relationships)
            .map(([n, d]) => `${n} (${d})`)
            .join("; ")}`
        : null,
      parsed.fixedContent ? `Core: ${parsed.fixedContent}` : null,
    ].filter(Boolean);
    return `## ${item.key} (${item.type})\n${bits.join("\n")}`;
  } catch {
    // Passages and other non-JSON item types store raw text.
    return `## ${item.key} (${item.type})\n${item.content}`;
  }
}

function textResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: text || "No results." }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function createMcpServer(db: PrismaClient): McpServer {
  const worlds = createWorldService(db);
  const userId = env.OWNER_ID;

  const server = new McpServer(
    { name: "worldbrain", version: "0.1.0" },
    {
      instructions:
        "worldbrain is a shared persistent context store. Search it before assuming you lack " +
        "background on a topic, and use world_remember to record durable facts so other tools " +
        "you switch to later start with the same context.",
    },
  );

  /** Resolves the target world(s): a specific id, or all of the owner's worlds when omitted. */
  async function resolveWorldIds(worldId?: string): Promise<string[]> {
    if (worldId) {
      const world = await worlds.get(userId, worldId);
      if (!world) throw new Error(`World not found: ${worldId}`);
      return [world.id];
    }
    return (await worlds.list(userId)).map((w) => w.id);
  }

  async function getCheckpoint(worldId: string): Promise<LorebookCheckpoint> {
    const world = await worlds.get(userId, worldId);
    if (!world) throw new Error(`World not found: ${worldId}`);
    return (world.checkpoint as LorebookCheckpoint | null) ?? ({} as LorebookCheckpoint);
  }

  // ── worlds_list ────────────────────────────────────────────────────────────
  server.registerTool(
    "worlds_list",
    {
      title: "List worlds",
      description: "List every world (context store) available, with its tags and entity counts.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const all = await worlds.list(userId);
      const rows = all.map((w) => {
        const cp = (w.checkpoint as LorebookCheckpoint | null) ?? ({} as LorebookCheckpoint);
        return {
          id: w.id,
          title: w.title,
          group: w.group,
          tags: w.tags,
          updatedAt: w.updatedAt.toISOString(),
          counts: {
            characters: cp.characters?.length ?? 0,
            locations: cp.locations?.length ?? 0,
            items: cp.items?.length ?? 0,
            chronology: cp.chronology?.length ?? 0,
          },
        };
      });

      const text = rows
        .map((r) => `- ${r.title} (id: ${r.id})${r.tags.length ? ` [${r.tags.join(", ")}]` : ""}`)
        .join("\n");
      return textResult(text, { worlds: rows });
    },
  );

  // ── world_search ───────────────────────────────────────────────────────────
  server.registerTool(
    "world_search",
    {
      title: "Search worlds",
      description:
        "Semantic search across a world's accumulated context. Combines vector similarity with " +
        "importance and recency, then augments with exact-name matches. Omit worldId to search all worlds.",
      inputSchema: {
        query: z.string().min(1).describe("What to look for, in natural language."),
        worldId: z.string().optional().describe("Restrict to one world. Omit to search all."),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, worldId, limit }) => {
      const worldIds = await resolveWorldIds(worldId);
      if (worldIds.length === 0) return textResult("No worlds exist yet.");

      const settings = await getSettings(db);
      if (!settings.embeddingEnabled) {
        throw new Error("Embeddings are disabled in settings — semantic search is unavailable.");
      }

      // "query" mode matters: instruction-aware embedding models need the query prefix, and
      // omitting it measurably degrades retrieval.
      const { embedding, model } = await embedText(query, settings.embeddingRouter, settings.embeddingModel, "query");

      const hits = await hybridLorebookSearch(db, embedding, userId, worldIds, limit, undefined, null, model);

      // DCI: exact-name recall for proper nouns whose embeddings are weak (unusual spellings,
      // short names). Catches what vector search structurally misses.
      const seen = new Set(hits.map((h) => h.key.toLowerCase()));
      const dciHits = await dciLookupByNames(db, worldIds, query.split(/\s+/), seen);

      const all = [...hits.map((h) => ({ ...h, source: "vector" })), ...dciHits.map((h) => ({ ...h, source: "dci" }))];

      const text = all.map(renderItem).join("\n\n");
      return textResult(text, {
        results: all.map((h: SimilarLorebookItem & { source: string }) => ({
          key: h.key,
          type: h.type,
          worldId: h.lorebookId,
          content: h.content,
          source: h.source,
        })),
      });
    },
  );

  // ── world_entity ───────────────────────────────────────────────────────────
  server.registerTool(
    "world_entity",
    {
      title: "Get an entity by name",
      description:
        "Fetch a single entity's full card by exact name. Resolves aliases and nicknames, so an " +
        "informal name still finds the canonical entity.",
      inputSchema: {
        name: z.string().min(1),
        worldId: z.string().optional().describe("Restrict to one world. Omit to search all."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, worldId }) => {
      const worldIds = await resolveWorldIds(worldId);
      const hits = await dciLookupByNames(db, worldIds, [name]);
      if (hits.length === 0) return textResult(`No entity named "${name}" found.`);
      return textResult(
        hits.map(renderItem).join("\n\n"),
        { entities: hits.map((h) => ({ key: h.key, type: h.type, worldId: h.lorebookId, content: h.content })) },
      );
    },
  );

  // ── world_chronology ───────────────────────────────────────────────────────
  server.registerTool(
    "world_chronology",
    {
      title: "Get a world's timeline",
      description: "Recent events in order, plus a condensed breadcrumb of older archived beats.",
      inputSchema: {
        worldId: z.string(),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ worldId, limit }) => {
      const cp = await getCheckpoint(worldId);
      const recent = (cp.chronology ?? []).slice(-limit);
      const archive = typeof cp.chronology_archive === "string" ? cp.chronology_archive : "";

      const text = [
        archive ? `[Earlier, archived] ${archive}` : "",
        ...recent.map((e) => `[${e.timestamp || "Event"}] ${e.summary}`),
      ]
        .filter(Boolean)
        .join("\n");

      return textResult(text, { chronology: recent, archive });
    },
  );

  // ── world_summary ──────────────────────────────────────────────────────────
  server.registerTool(
    "world_summary",
    {
      title: "Get a world's macro summary",
      description: "The rolling summary, current scene, and core cast — the big picture at a glance.",
      inputSchema: { worldId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ worldId }) => {
      const cp = await getCheckpoint(worldId);
      const core = (cp.characters ?? []).filter((c) => c.importance === "core");

      const text = [
        cp.summary ? `# Summary\n${cp.summary}` : "",
        cp.scene ? `# Current scene\n${cp.scene.location} — ${cp.scene.activity} (${cp.scene.mood})` : "",
        core.length ? `# Core cast\n${core.map((c) => `- ${c.name}: ${c.blurb}`).join("\n")}` : "",
        cp.world_laws?.length ? `# World laws\n${cp.world_laws.map((l) => `- ${l}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      return textResult(text, {
        summary: cp.summary ?? null,
        scene: cp.scene ?? null,
        coreCast: core.map((c) => ({ name: c.name, blurb: c.blurb })),
        worldLaws: cp.world_laws ?? [],
      });
    },
  );

  // ── world_remember (write) ─────────────────────────────────────────────────
  server.registerTool(
    "world_remember",
    {
      title: "Record durable context",
      description:
        "Record something worth remembering into a world, so other tools see it later. Describe it " +
        "in plain prose — it will be extracted into structured entities, relationships and timeline " +
        "entries automatically. Use for durable facts and decisions, not transient chatter.",
      inputSchema: {
        worldId: z.string(),
        text: z.string().min(1).describe("What to remember, in natural language."),
      },
      // Not read-only, but not destructive either: the merge never deletes, so a bad write adds
      // noise rather than losing anything.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ worldId, text }) => {
      const cp = await getCheckpoint(worldId);
      const settings = await getSettings(db);

      // Reuse the existing extraction pass rather than asking the calling LLM to hand-author a
      // valid delta — that would spend its attention on schema compliance, and this pipeline is
      // already tuned for exactly this job.
      const extraction = await extractNarrativeDelta({
        router: settings.llmRouter as RouterType,
        model: settings.llmModel ?? "gpt-4o-mini",
        conversation: text,
        currentLorebook: cp,
        tags: [],
      });

      if (!extraction?.lorebook) {
        return textResult("Nothing durable was extracted from that text — nothing was recorded.");
      }

      const lore = extraction.lorebook;
      const delta: LorebookDelta = {
        add: lore.add ?? [],
        update: lore.update ?? [],
        new_rules: lore.new_rules ?? [],
        new_plot_threads: lore.new_plot_threads ?? [],
        atmosphere: lore.atmosphere,
        world_laws: lore.world_laws ?? [],
        narrative_summary: lore.narrative_summary,
        chronology_entries: extraction.chronology ?? [],
      };

      // The transactional path — the only safe way to write, since several agents may be
      // recording into the same world at once. See worldWrite.ts.
      const { seq } = await applyDeltaTransactional(db, userId, worldId, delta);

      const added = delta.add?.map((e) => e.name).filter(Boolean) ?? [];
      const updated = delta.update?.map((e) => e.name).filter(Boolean) ?? [];
      logger.info("world_remember applied", { worldId, seq, added: added.length, updated: updated.length });

      const summary = [
        added.length ? `Added: ${added.join(", ")}` : "",
        updated.length ? `Updated: ${updated.join(", ")}` : "",
        delta.chronology_entries?.length ? `Timeline entries: ${delta.chronology_entries.length}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return textResult(summary || "Recorded.", { added, updated, seq });
    },
  );

  return server;
}
