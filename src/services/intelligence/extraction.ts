import { createLogger } from "../../utils/logger.js";
import type { RouterType } from "../llm/routerDispatch.js";
import {
  buildPromptContextBlocks,
  buildSystemPrompt,
  formatMemoriesAsXml,
  type MemoryForXml,
  requestJson,
} from "../llm/structuredRequest.js";
import { extractMentionedEntities, formatEntitiesForExtraction } from "../world/dciSearch.js";
import { type UnifiedExtractionResult, unifiedExtractionSchema } from "./types.js";

const logger = createLogger("intelligence:extraction");

import { EXTRACTION_PROMPT } from "../prompt/constants.js";

export interface ExtractionInput {
  router: RouterType;
  model: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  conversation: string;
  /** Dialogue-only text (user/assistant turns) used for entity mention detection.
   *  Kept separate from `conversation` so the RP system prompt's injected entity blurbs
   *  don't pollute the mention scan. Falls back to `conversation` when omitted. */
  mentionScanText?: string;
  currentWorld?: any;
  tags: Array<{ name: string; description?: string | null }>;
  existingMemories?: MemoryForXml[];
  outOfScopeMemories?: MemoryForXml[];
  storySummary?: string;
  currentChatId?: string;
  conversationTokens?: number;
  messageCount?: number;
  connectedWorlds?: Array<{
    title: string;
    tags: string[];
    characters: string[];
    locations: string[];
    items: string[];
  }>;
  template?: string | null;
  apiKey?: string;
}

/**
 * Perform a single-pass extraction of all narrative developments, world-building updates,
 * and durable RAG memories from a conversation exchange.
 */
export const extractDelta = async (
  input: ExtractionInput,
): Promise<UnifiedExtractionResult | null> => {
  const { currentWorld: cp } = input;

  // 1. Prepare World context
  // DCI-enhanced entity formatting: entities mentioned in the conversation get full detail;
  // core entities always get full detail; everything else gets a brief stub.
  // This replaces the old bulk-build + 10,000-char hard truncation — the extractor now
  // sees complete data for entities relevant to this turn without a lossy cutoff.
  //
  // Scan ONLY the actual dialogue (mentionScanText) when provided. input.conversation embeds
  // the RP system prompt, which already contains every injected entity's blurb — scanning that
  // would mark every injected entity as "mentioned" and hand it full detail, defeating the stub
  // tiering and inflating tokens. Falls back to conversation if no scan text was supplied.
  const scanText = input.mentionScanText ?? input.conversation;
  const mentionedEntities = cp ? extractMentionedEntities(scanText, cp) : [];
  const mentionedNames = new Set(mentionedEntities.map((e) => e.name.toLowerCase()));
  const existingLoreEntities = cp ? formatEntitiesForExtraction(cp, mentionedNames) : "None yet";

  logger.debug("DCI entity context built for extractor", {
    totalChars: existingLoreEntities.length,
    mentionedCount: mentionedEntities.length,
    totalCharacters: cp?.characters?.length ?? 0,
    totalLocations: cp?.locations?.length ?? 0,
    totalItems: cp?.items?.length ?? 0,
  });

  // Cap chronology to the recent tail — the generation prompt caps at 15, extraction gets
  // double for dedup context. Without a cap, long RPs render hundreds of lines here on
  // every extraction pass. Older continuity is covered by the story summary.
  // Older beats pruned by the rollup lifecycle are surfaced as a compact archive breadcrumb
  // so the extractor stays aware of them (and doesn't re-extract them as "new").
  const chronologyArchiveLine =
    cp && typeof cp.chronology_archive === "string" && cp.chronology_archive.trim()
      ? `[Earlier (archived, retrievable via RAG)] ${cp.chronology_archive}\n`
      : "";
  const recentChronology = cp
    ? (cp.chronology ?? [])
        .slice(-30)
        .map((e: any) => `[${e.timestamp || "Event"}] ${e.summary}`)
        .join("\n")
    : "";
  const existingChronology = `${chronologyArchiveLine}${recentChronology}`.trim() || "None yet";

  const connectedLoreContext =
    (input.connectedWorlds ?? [])
      .map(
        (lb) =>
          `[BOOK: ${lb.title}] (Tags: ${(lb.tags || []).join(", ")}) Chars: ${lb.characters.join(", ")}; Locs: ${lb.locations.join(", ")}; Items: ${lb.items.join(", ")}`,
      )
      .join("\n") || "None";

  // 2. Prepare Memory context (XML format for token efficiency)
  const tagList =
    input.tags.length > 0
      ? input.tags.map((t) => (t.description ? `${t.name} (${t.description})` : t.name)).join(", ")
      : "(none)";

  const existingMemoriesXml = formatMemoriesAsXml(
    input.existingMemories ?? [],
    input.outOfScopeMemories ?? [],
    input.currentChatId,
  );

  // 3. Build the Unified Prompt (Mission Style)
  const basePrompt = input.template?.trim().length ? input.template.trim() : EXTRACTION_PROMPT;

  const contextBlocks = buildPromptContextBlocks(input);

  const systemPrompt = buildSystemPrompt(basePrompt, [
    ...contextBlocks,
    "",
    "--- EXISTING PROJECT CONTEXT ---",
    "EXISTING ENTITIES:",
    existingLoreEntities,
    "",
    "EXISTING DECISION LOG:",
    existingChronology,
    "",
    "ENTITIES FROM LINKED BOOKS (Do not re-create these):",
    connectedLoreContext,
    "",
    "--- PROJECT SUMMARY (What This Is So Far) ---",
    input.storySummary || "None yet",
    "",
    "--- EXISTING RAG MEMORY CONTEXT ---",
    "EXISTING MEMORIES (XML):",
    existingMemoriesXml,
    "",
    "ALLOWED RAG TAGS:",
    tagList,
    "",
    "Return a SINGLE VALID JSON OBJECT only. Match the provided schema strictly. If 'memories' or 'chronology' are empty, return [].",
  ]);

  // Anti-Bleed: On large contexts, the LLM may "forget" its system instructions and
  // continue the roleplay instead of returning JSON. This grounding directive is appended
  // to the very end of the conversation payload to snap the model back into extraction mode.
  const antiBleedDirective = [
    "",
    "=== END OF CONVERSATION LOG ===",
    "",
    "[SYSTEM DIRECTIVE]: The conversation above has ended. You are the extractor AI, NOT a roleplay participant.",
    "Do NOT continue the story. Do NOT write dialogue or narration.",
    "Your ONLY task is to analyze the conversation above and extract narrative data.",
    'Output EXACTLY this JSON structure: {"characters":[{"name":"...","blurb":"...","importance":"...","status":"...","traits":[],"aliases":[],"relationships":{},"witnessed_facts":[],"entity_type":"character|location|item|knowledge"}],"timeline":[{"summary":"**...**","timestamp":"...","key_events":[]}],"new_rules":[{"name":"...","blurb":"..."}],"new_plot_threads":[{"title":"...","status":"open|escalating|resolved"}],"scene":{"location":"...","present_characters":[],"activity":"...","mood":"..."},"narrative_summary":"...","atmosphere":"...","world_laws":[],"memories":[{"action":"create","memoryIds":[],"content":"...","importanceScore":3}]}',
    'For "aliases": include nicknames, shortened names, epithets, or alternate forms the character is actually called in the text (e.g. "Mione" for Hermione, "Prof. McG" for McGonagall). Use the full canonical name as "name" and put every other form the text uses in "aliases". Omit if none.',
    'For "relationships": when characters actually interact this turn, update the relationship entry to reflect how the dynamic evolved in the scene (e.g. "Draco": "rivalry, escalating after the duel"; "Ron": "closer after he apologized"). Base this on what happened, not pre-written assumptions. Key by the other character\'s canonical name.',
    "IMPORTANT: 'characters' must be an ARRAY of objects with 'name' field containing ALL entity types — characters, locations, AND items. Do NOT use object-keyed format. Do NOT invent keys. Use entity_type='location' for ALL named places, entity_type='knowledge' for research discoveries, theories, formulas, or documented lore.",
    "Start your response directly with the opening brace: {",
  ].join("\n");

  logger.info("Calling requestJson for narrative extraction", {
    router: input.router,
    model: input.model,
    provider: input.provider ?? null,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  });

  const result = await requestJson(unifiedExtractionSchema, {
    router: input.router,
    model: input.model,
    provider: input.provider,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    reasoningEffort: input.reasoningEffort,
    systemPrompt,
    userPrompt: input.conversation + antiBleedDirective,
    apiKey: input.apiKey,
  });

  if (!result) {
    logger.error("requestJson returned null — no usable response from LLM", {
      router: input.router,
      model: input.model,
    });
    return null;
  }

  logger.info("requestJson succeeded — data returned", {
    router: input.router,
    model: input.model,
    usage: result.usage,
    worldAddCount: result.data?.world?.add?.length ?? 0,
    worldUpdateCount: result.data?.world?.update?.length ?? 0,
    chronologyCount: result.data?.chronology?.length ?? 0,
    memoriesCount: result.data?.memories?.length ?? 0,
  });

  return {
    ...result.data,
    _raw: result.raw,
    usage: result.usage,
  };
};
