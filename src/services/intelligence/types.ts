import { z } from "zod";
import {
  ALIAS_MAX_CHARS,
  ALIASES_MAX_COUNT,
  EXPOSURE_TAG_MAX_CHARS,
  EXPOSURE_TAGS_MAX_COUNT,
  RELATIONSHIP_VALUE_MAX_CHARS,
  TRAIT_MAX_CHARS,
  TRAITS_MAX_COUNT,
} from "../../config/limits.js";
import { createLogger } from "../../utils/logger.js";
import type { TokenUsage } from "../llm/types.js";
import { normalizeExtractionOutput } from "./normalizeExtraction.js";

const logger = createLogger("intelligence:schema");

/** Filter + cap an extracted string array, logging loudly about anything dropped. */
function hygieneFilter(field: string, maxChars: number, maxCount: number) {
  return (arr: string[]): string[] => {
    const kept = arr.filter((x) => x.trim().length > 0 && x.length <= maxChars);
    const clipped = kept.slice(0, maxCount);
    const dropped = arr.length - clipped.length;
    if (dropped > 0) {
      logger.warn(`Extraction hygiene dropped ${field} entries`, {
        field,
        dropped,
        maxChars,
        maxCount,
        oversized: arr.filter((x) => x.length > maxChars).map((x) => x.slice(0, 80)),
      });
    }
    return clipped;
  };
}

export const intelligenceEntitySchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1).optional(),
    blurb: z.string().min(1),
    importance: z.enum(["core", "middle", "minor"]).default("minor"),
    status: z.string().optional(),
    tags: z.array(z.string()).default([]),
    traits: z
      .array(z.string())
      // Prevent entire blurb blocks from bleeding into traits — dropped WITH a log
      .transform(hygieneFilter("traits", TRAIT_MAX_CHARS, TRAITS_MAX_COUNT))
      .default([]),
    relationships: z
      .record(z.any())
      .transform((val) => {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(val || {})) {
          if (typeof v === "string") result[k] = v;
          else if (typeof v === "object" && v !== null) {
            const flattened = JSON.stringify(v);
            if (flattened.length > RELATIONSHIP_VALUE_MAX_CHARS) {
              logger.warn("Relationship value was an oversized object; clipped", {
                key: k,
                length: flattened.length,
                max: RELATIONSHIP_VALUE_MAX_CHARS,
              });
            }
            result[k] = flattened.substring(0, RELATIONSHIP_VALUE_MAX_CHARS);
          } else result[k] = String(v);
        }
        return result;
      })
      .default({}),
    witnessed_facts: z.array(z.string()).default([]),
    aliases: z
      .array(z.string())
      .transform(hygieneFilter("aliases", ALIAS_MAX_CHARS, ALIASES_MAX_COUNT))
      .default([]),
    exposure_tags: z
      .array(z.string())
      .transform(hygieneFilter("exposure_tags", EXPOSURE_TAG_MAX_CHARS, EXPOSURE_TAGS_MAX_COUNT))
      .default([]),
    fixedContent: z.string().optional(), // Immutable Core Card — only written on initial entry creation
    entity_type: z.string().optional(),
    type: z.string().optional(),
    confidence: z.number().min(0).max(1).default(1),
    durability: z.enum(["ephemeral", "stable"]).default("stable"),
  })
  .transform((data) => {
    const rawType = (data.entity_type ?? data.type ?? "character").toLowerCase();

    let mappedType: "character" | "location" | "item" | "knowledge" | "event" = "character";
    if (rawType.includes("char") || rawType.includes("person") || rawType.includes("actor")) mappedType = "character";
    else if (
      rawType.includes("loc") ||
      rawType.includes("place") ||
      rawType.includes("room") ||
      rawType.includes("area") ||
      rawType.includes("site") ||
      rawType.includes("venue") ||
      rawType.includes("setting") ||
      rawType.includes("build") ||
      rawType.includes("region") ||
      rawType.includes("district") ||
      rawType.includes("landmark") ||
      rawType.includes("structure") ||
      rawType.includes("world") ||
      rawType.includes("realm")
    )
      mappedType = "location";
    else if (
      rawType.includes("item") ||
      rawType.includes("object") ||
      rawType.includes("thing") ||
      rawType.includes("artifact") ||
      rawType.includes("prop")
    )
      mappedType = "item";
    else if (
      rawType.includes("know") ||
      rawType.includes("research") ||
      rawType.includes("fact") ||
      rawType.includes("lore") ||
      rawType.includes("spell") ||
      rawType.includes("rule")
    )
      mappedType = "knowledge";
    else if (
      rawType.includes("event") ||
      rawType.includes("beat") ||
      rawType.includes("occur") ||
      rawType.includes("incident") ||
      rawType.includes("scene")
    )
      mappedType = "event";

    return {
      ...data,
      name: data.name ?? data.id ?? "Unknown Entity",
      entity_type: mappedType,
    };
  });

// Action schema for memories (durable RAG facts)
const intelligenceMemoryActionSchema = z.object({
  action: z.enum(["create", "update", "supersede", "merge", "reinforce"]).catch("create"),
  memoryIds: z.array(z.string()).optional().default([]),
  content: z.string().nullable().optional().default(""),
  importanceScore: z.number().min(1).max(5).nullable().optional().default(3),
  reasoning: z.string().nullable().optional().default(""),
  nsfw: z.boolean().optional().default(false),
  actualTags: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional().default(null),
      }),
    )
    .optional()
    .default([]),
  suggestedTags: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional().default(null),
      }),
    )
    .optional()
    .default([]),
  confidence: z.number().min(0).max(1).default(1),
});

// Unified extraction result
export const unifiedExtractionSchema = z
  .object({
    lorebook: z
      .object({
        add: z.array(intelligenceEntitySchema).default([]),
        update: z.array(intelligenceEntitySchema).default([]),
        new_rules: z.array(z.object({ name: z.string(), blurb: z.string() })).default([]),
        new_plot_threads: z.array(z.object({ title: z.string(), status: z.string() })).default([]),
        atmosphere: z.string().optional(),
        world_laws: z.array(z.string()).default([]),
        narrative_summary: z.string().optional(),
      })
      .optional(),
    lorebook_updates: z.any().optional(),
    updates: z.any().optional(),
    session_updates: z.any().optional(),
    // Root-level keys (handled in transform)
    add: z.any().optional(),
    update: z.any().optional(),
    atmosphere: z.any().optional(),
    world_laws: z.any().optional(),
    narrative_summary: z.any().optional(),
    new_rules: z.any().optional(),
    new_plot_threads: z.any().optional(),
    characters: z.any().optional(),
    timeline: z.any().optional(),
    research: z.any().optional(),
    memories: z
      .union([
        z.array(intelligenceMemoryActionSchema),
        intelligenceMemoryActionSchema.transform((val) => [val]),
        z.record(intelligenceMemoryActionSchema).transform((val) => Object.values(val)),
      ])
      .catch([])
      .default([]),
    chronology: z
      .union([
        z.array(
          z.union([
            z.string().transform((str) => ({ summary: str, key_events: [] })),
            z.preprocess(
              (val: any) => {
                if (typeof val !== "object" || !val) return val;
                const rawSummary = val.summary ?? val.title ?? val.name ?? val.event ?? val.description;
                return {
                  ...val,
                  summary: rawSummary,
                };
              },
              z.object({
                timestamp: z.string().optional(),
                summary: z.string().catch("Unknown event"),
                key_events: z.array(z.string()).catch([]).default([]),
              }),
            ),
          ]),
        ),
        z
          .object({
            timestamp: z.string().optional(),
            summary: z.string().catch("Unknown event"),
            key_events: z.array(z.string()).catch([]).default([]),
          })
          .transform((val) => [val]),
        z.record(z.any()).transform((val) => {
          // Handle when models return an indexed object instead of an array
          return Object.values(val).map((v) => {
            if (typeof v === "string") return { summary: v, key_events: [] };

            // Handle common LLM aliases instead of 'summary'
            const rawSummary = v?.summary ?? v?.title ?? v?.name ?? v?.event ?? v?.description;

            return {
              timestamp: v?.timestamp?.toString(),
              summary: rawSummary?.toString() ?? "Unknown event",
              key_events: Array.isArray(v?.key_events) ? v.key_events : [],
            };
          });
        }),
        z.string().transform((str) => [{ summary: str, key_events: [] }]),
      ])
      .catch([])
      .default([]),
    scene: z
      .union([
        z.string().transform((str) => ({
          location: "Unknown",
          present_characters: [],
          activity: str,
          mood: "Neutral",
          atmosphere: undefined,
          world_laws: [],
        })),
        z
          .object({
            location: z.string().optional(),
            current_location: z.string().optional(),
            present_characters: z.array(z.string()).optional(),
            key_figures_present: z.array(z.string()).optional(),
            activity: z.string().optional(),
            narrative_context: z.string().optional(),
            mood: z.string().optional(),
            atmosphere: z.string().optional(),
            world_laws: z.array(z.string()).default([]),
          })
          .transform((data) => ({
            location: data.location ?? data.current_location ?? "Unknown",
            present_characters: data.present_characters ?? data.key_figures_present ?? [],
            activity: data.activity ?? data.narrative_context ?? "None",
            mood: data.mood ?? "Neutral",
            atmosphere: data.atmosphere,
            world_laws: data.world_laws,
          })),
      ])
      .optional(),
  })
  .transform((data: any) => normalizeExtractionOutput(data));

export type UnifiedExtractionResult = z.infer<typeof unifiedExtractionSchema> & {
  usage?: TokenUsage;
};
