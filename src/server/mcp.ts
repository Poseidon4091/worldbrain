import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { env } from "../env.js";
import { embedText } from "../services/embedding/index.js";
import { hybridSearch, type SimilarWorldItem, tagGatedSearch } from "../services/embedding/vectorSearch.js";
import { extractNarrativeDelta } from "../services/intelligence/narrativeIntelligence.js";
import { dciLookupByNames, extractMentionedEntities, tagAppearsInText } from "../services/world/dciSearch.js";
import type { WorldCheckpoint, WorldDelta } from "../services/world/merge.js";
import { createWorldService } from "../services/world/worldService.js";
import { applyDeltaTransactional } from "../services/world/worldWrite.js";
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
        "worldbrain is a shared context store holding one book per project, read and written by " +
        "every AI tool the user works with.\n\n" +
        "Call world_context with the user's request BEFORE starting a task — it is cheap and tells " +
        "you what has already been established (conventions, prior decisions, architecture) so you " +
        "don't contradict work done in another tool.\n\n" +
        "When you learn something durable — a decision, a convention, how a subsystem works — record " +
        "it with world_remember. The user will pick this up in a different tool later, and anything " +
        "you don't record is lost at the end of this session.",
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

  async function getCheckpoint(worldId: string): Promise<WorldCheckpoint> {
    const world = await worlds.get(userId, worldId);
    if (!world) throw new Error(`World not found: ${worldId}`);
    return (world.checkpoint as WorldCheckpoint | null) ?? ({} as WorldCheckpoint);
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
        const cp = (w.checkpoint as WorldCheckpoint | null) ?? ({} as WorldCheckpoint);
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

  // ── world_create ───────────────────────────────────────────────────────────
  server.registerTool(
    "world_create",
    {
      title: "Create a project book",
      description:
        "Create a new book — typically one per project. Give it tags that name the project and its " +
        "aliases (repo name, product name, shorthand the user actually says), because those are what " +
        "world_context matches against to decide the book is relevant.",
      inputSchema: {
        title: z.string().min(1).describe("Project name, e.g. 'Home Assistant App'."),
        tags: z
          .array(z.string())
          .default([])
          .describe("Trigger words: project name, repo name, nicknames the user uses for it."),
        tagGated: z
          .boolean()
          .default(false)
          .describe("If true, this book stays silent unless one of its tags is explicitly named."),
        readOnly: z
          .boolean()
          .default(false)
          .describe("If true, agents may read but never write. For imported specs treated as canon."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, tags, tagGated, readOnly }) => {
      const world = await worlds.create(userId, { title, tags, tagGated, readOnly });
      return textResult(`Created book "${title}" (id: ${world.id}).`, {
        worldId: world.id,
        title,
        tags,
        tagGated,
        readOnly,
      });
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

      const hits = await hybridSearch(db, embedding, userId, worldIds, limit, undefined, null, model);

      // DCI: exact-name recall for proper nouns whose embeddings are weak (unusual spellings,
      // short names). Catches what vector search structurally misses.
      const seen = new Set(hits.map((h) => h.key.toLowerCase()));
      const dciHits = await dciLookupByNames(db, worldIds, query.split(/\s+/), seen);

      const all = [...hits.map((h) => ({ ...h, source: "vector" })), ...dciHits.map((h) => ({ ...h, source: "dci" }))];

      const text = all.map(renderItem).join("\n\n");
      return textResult(text, {
        results: all.map((h: SimilarWorldItem & { source: string }) => ({
          key: h.key,
          type: h.type,
          worldId: h.worldId,
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
        { entities: hits.map((h) => ({ key: h.key, type: h.type, worldId: h.worldId, content: h.content })) },
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

  // ── world_context ──────────────────────────────────────────────────────────
  server.registerTool(
    "world_context",
    {
      title: "Get relevant context for what you're working on",
      description:
        "Call this FIRST, before starting any task. Pass the user's request verbatim; it returns " +
        "everything already known that is relevant — project conventions, prior decisions, entities " +
        "mentioned by name — across every project book. Cheap and fast: it matches names and tags " +
        "literally rather than embedding the query, so there is no reason not to call it every time.",
      inputSchema: {
        text: z.string().min(1).describe("The request or task text to find relevant context for."),
        semantic: z
          .boolean()
          .default(false)
          .describe("Also run semantic search. Broader recall, but costs an embedding call."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ text, semantic }) => {
      const all = await worlds.list(userId);
      if (all.length === 0) return textResult("No project books exist yet.");

      const sections: string[] = [];
      const structured: Array<{ worldId: string; title: string; trigger: string; items: unknown[] }> = [];

      for (const world of all) {
        const cp = (world.checkpoint as WorldCheckpoint | null) ?? ({} as WorldCheckpoint);

        // A tag-gated book is opt-in: it stays silent until something it declares is named. That
        // is the point of the mode — a book of conventions for one project shouldn't bleed into
        // unrelated work just because the wording looks vaguely similar.
        if (world.tagGated) {
          const hits = await tagGatedSearch(db, text, world);
          if (hits.length === 0) continue;
          sections.push(`# ${world.title} (tag match)\n${hits.map(renderItem).join("\n\n")}`);
          structured.push({ worldId: world.id, title: world.title, trigger: "tag", items: hits });
          continue;
        }

        // An untagged book contributes whichever of its entities are actually named in the text.
        const mentioned = extractMentionedEntities(text, cp);
        // The book's own title/tags being named means the whole project is under discussion, so
        // its core entities are relevant even when none of them were individually named.
        const bookNamed =
          tagAppearsInText(world.title, text) || world.tags.some((t) => t.trim() && tagAppearsInText(t, text));

        const names = mentioned.map((m) => m.name);
        if (bookNamed) {
          names.push(...(cp.characters ?? []).filter((c) => c.importance === "core").map((c) => c.name));
        }
        if (names.length === 0) continue;

        const hits = await dciLookupByNames(db, [world.id], names);
        if (hits.length === 0) continue;

        const trigger = bookNamed ? "book named" : "entity mentioned";
        sections.push(`# ${world.title} (${trigger})\n${hits.map(renderItem).join("\n\n")}`);
        structured.push({ worldId: world.id, title: world.title, trigger, items: hits });
      }

      // Opt-in semantic pass, for when literal matching finds nothing but related context exists.
      if (semantic) {
        const settings = await getSettings(db);
        if (settings.embeddingEnabled) {
          const { embedding, model } = await embedText(
            text,
            settings.embeddingRouter,
            settings.embeddingModel,
            "query",
          );
          // Tag-gated books are excluded on purpose: letting semantic similarity open them would
          // defeat the gate they were configured with.
          const openIds = all.filter((w) => !w.tagGated).map((w) => w.id);
          const hits = await hybridSearch(db, embedding, userId, openIds, 10, undefined, null, model);
          if (hits.length > 0) {
            sections.push(`# Semantically related\n${hits.map(renderItem).join("\n\n")}`);
            structured.push({ worldId: "", title: "Semantically related", trigger: "semantic", items: hits });
          }
        }
      }

      if (sections.length === 0) {
        return textResult("Nothing relevant found. Proceed, and consider recording what you learn.");
      }
      return textResult(sections.join("\n\n"), { context: structured });
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
        currentWorld: cp,
        tags: [],
      });

      if (!extraction?.world) {
        return textResult("Nothing durable was extracted from that text — nothing was recorded.");
      }

      const lore = extraction.world;
      const delta: WorldDelta = {
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
