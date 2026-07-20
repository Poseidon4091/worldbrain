import { createLogger } from "../../utils/logger.js";
import { intelligenceEntitySchema } from "./types.js";

const logger = createLogger("intelligence:normalize-extraction");

function normalizeImportance(raw: string | undefined): "core" | "middle" | "minor" {
  if (!raw) return "minor";
  const lower = raw.toLowerCase();
  if (["core", "protagonist", "co-protagonist", "main", "primary"].some((k) => lower.includes(k))) return "core";
  if (["middle", "secondary", "supporting", "antagonist", "recurring"].some((k) => lower.includes(k))) return "middle";
  return "minor";
}

export function normalizeExtractionOutput(data: any) {
  // Aliases for the new "Mission" style prompt results
  // LLMs sometimes return objects keyed by name instead of arrays. Let's normalize that.
  let characters: any[] = [];
  if (Array.isArray(data.characters)) {
    characters = data.characters;
  } else if (typeof data.characters === "object" && data.characters !== null) {
    characters = Object.entries(data.characters).map(([name, val]: [string, any]) => ({
      ...val,
      name,
      // Map Kimi's alternative field names to our schema
      blurb: val.blurb ?? val.motivations ?? val.description ?? val.summary ?? name,
      importance: normalizeImportance(val.importance ?? val.role),
      traits: val.traits ?? val.key_facts ?? [],
    }));
  }
  // Also normalize array-format characters that may use alternative field names
  characters = characters.map((c: any) => ({
    ...c,
    blurb: c.blurb ?? c.motivations ?? c.description ?? c.summary ?? c.name ?? "Unknown",
    importance: normalizeImportance(c.importance ?? c.role),
    traits: c.traits ?? c.key_facts ?? [],
  }));

  const timeline = data.timeline ?? [];

  let research = [];
  if (Array.isArray(data.research)) {
    research = data.research;
  } else if (typeof data.research === "object" && data.research !== null) {
    research = Object.entries(data.research).map(([title, val]: [string, any]) => ({
      title,
      ...val,
    }));
  }

  const loreSource = data.lorebook ?? data.lorebook_updates ?? data.updates ?? data.session_updates ?? {};

  // Pivot flat characters/timeline/research into existing structure
  const add: any[] = [...(loreSource.add ?? data.add ?? [])];
  const update: any[] = [...(loreSource.update ?? data.update ?? [])];

  for (const char of characters) {
    // If it has a confidence or delta logic, it's definitely an update or high-intent add
    if (char.confidence !== undefined || char.traits?.some((t: string) => t.includes(","))) {
      update.push(char);
    } else {
      add.push(char);
    }
  }

  const chronology = [...(data.chronology ?? [])];
  for (const event of timeline) {
    // Determine the best values from the generic event object
    const timestamp = event.timestamp ?? event.location ?? event.date ?? event.time;
    let summary = event.summary ?? event.title ?? event.name ?? event.location;
    let key_events = event.key_events ?? event.beats ?? event.events ?? event.details ?? [];

    // Heuristic for string-key object maps (e.g. { "Scene Name": ["beat 1", "beat 2"] })
    if (!summary && typeof event === "object") {
      const keys = Object.keys(event).filter((k) => k !== "timestamp" && k !== "key_events" && k !== "date");
      if (keys.length === 1) {
        summary = keys[0];
        if (key_events.length === 0 && Array.isArray(event[keys[0]!])) {
          key_events = event[keys[0]!];
        }
      }
    }

    // Fallback: If no summary exists, but we have key events, use the first key event
    if (!summary && key_events.length > 0 && typeof key_events[0] === "string") {
      summary = key_events[0];
    }
    // Fallback: If we have a location, use that
    if (!summary && timestamp) {
      summary = `Event in ${timestamp}`;
    }

    summary = summary ?? "Unnamed Event";

    // Fallback logic if it's just a string
    if (typeof event === "string") {
      chronology.push({ summary: event, key_events: [] });
    } else {
      chronology.push({ timestamp, summary, key_events });
    }
  }

  const memories = [...(data.memories ?? [])];
  for (const r of research) {
    if (typeof r === "string") {
      // Push to RAG memories
      memories.push({
        action: "create",
        content: r,
        reasoning: "Extracted Research",
        importanceScore: 3,
        confidence: 0.9,
      });
      // Also push to lorebook knowledge entities (populates Research tab)
      add.push({
        name: r,
        blurb: r,
        entity_type: "knowledge",
        importance: "minor",
      });
    } else {
      const name = r.title ?? r.name ?? "Research Entry";
      const blurb = r.content ?? r.summary ?? r.description ?? r.blurb ?? JSON.stringify(r);
      // Push to RAG memories
      memories.push({
        action: "create",
        content: blurb,
        reasoning: name,
        importanceScore: 3,
        confidence: 0.9,
      });
      // Also push to lorebook knowledge entities (populates Research tab)
      add.push({
        name,
        blurb,
        entity_type: "knowledge",
        importance: r.importance ?? "minor",
        traits: Array.isArray(r.traits) ? r.traits : [],
      });
    }
  }

  const finalAdd: any[] = [];
  const finalUpdate: any[] = [];

  logger.info("Entity pivot: processing raw add/update lists", {
    rawAddCount: add.length,
    rawUpdateCount: update.length,
    rawCharacterCount: characters.length,
  });

  for (const a of add) {
    const parsed = intelligenceEntitySchema.safeParse(a);
    if (parsed.success) {
      finalAdd.push(parsed.data);
    } else {
      logger.warn("Entity dropped from ADD list: failed schema validation", {
        zodErrors: parsed.error.format(),
      });
    }
  }

  for (const u of update) {
    const parsed = intelligenceEntitySchema.safeParse(u);
    if (parsed.success) {
      finalUpdate.push(parsed.data);
    } else {
      logger.warn("Entity dropped from UPDATE list: failed schema validation", {
        zodErrors: parsed.error.format(),
      });
    }
  }

  logger.info("Entity pivot complete", {
    finalAddCount: finalAdd.length,
    finalUpdateCount: finalUpdate.length,
    droppedAdd: add.length - finalAdd.length,
    droppedUpdate: update.length - finalUpdate.length,
  });

  return {
    ...data,
    chronology,
    memories,
    lorebook: {
      add: finalAdd,
      update: finalUpdate,
      new_rules: loreSource.new_rules ?? data.new_rules ?? [],
      new_plot_threads: loreSource.new_plot_threads ?? data.new_plot_threads ?? [],
      atmosphere: loreSource.atmosphere ?? data.atmosphere,
      world_laws: loreSource.world_laws ?? data.world_laws ?? [],
      narrative_summary: loreSource.narrative_summary ?? data.narrative_summary,
    },
  };
}
