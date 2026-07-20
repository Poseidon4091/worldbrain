import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { createLogger } from "../../utils/logger.js";
import { createModelClient, createModelClientWithKey, type RouterType } from "./routerDispatch.js";

const logger = createLogger("llm:structuredRequest");

const JSON_RETRIES = 3;

function getStructuredFallbackRouter(router: RouterType): RouterType | null {
  switch (router) {
    case "nanogpt":
      return "openrouter";
    case "nanogpt_external":
      return "openrouter_external";
    default:
      return null;
  }
}

export const parseJson = (raw: string) => {
  if (!raw) return null;

  // Step 1: strip markdown code fences (e.g. ```json ... ``` that Kimi adds)
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)(?:```\s*)?$/);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }
  if (!text) return null;

  // Step 2: direct parse (fast path)
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  // Step 3: extract outermost { ... } then try again
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }

  // Step 4: jsonrepair — handles truncated, trailing-comma, and other common LLM quirks
  try {
    const candidate = start >= 0 ? text.slice(start) : text;
    return JSON.parse(jsonrepair(candidate));
  } catch {
    return null;
  }
};

export const clamp = (value: string, max: number) => {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trim();
};

export const requestJson = async <T extends z.ZodTypeAny>(
  schema: T,
  params: {
    model: string;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: string;
    provider?: string;
    systemPrompt: string;
    userPrompt: string;
    router: RouterType;
    responseFormat?: "text" | "json" | { type: "json_schema"; jsonSchema: Record<string, any> };
    apiKey?: string;
    /** Override the number of retry attempts (default: JSON_RETRIES = 3). Use 1 to fast-fail. */
    maxAttempts?: number;
  },
): Promise<{ data: z.infer<T>; usage: any; raw: string } | null> => {
  const attemptRequest = async (
    router: RouterType,
    provider: string | undefined,
    phase: "primary" | "fallback",
  ): Promise<{ data: z.infer<T>; usage: any; raw: string } | null> => {
    const client = params.apiKey ? createModelClientWithKey(router, params.apiKey) : createModelClient(router);
    const responseFormat = params.responseFormat ?? ("json" as const);
    const retries = params.maxAttempts ?? JSON_RETRIES;

    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const response = await client.createCompletion({
          model: params.model,
          provider,
          temperature: params.temperature,
          maxOutputTokens: params.maxTokens,
          reasoningEffort: params.reasoningEffort,
          responseFormat,
          messages: [
            { role: "system", content: params.systemPrompt },
            { role: "user", content: params.userPrompt },
          ],
        });

        let parsed = parseJson(response.text);

        // Some models (e.g. Gemini) return an array instead of the expected object.
        if (Array.isArray(parsed)) {
          if (parsed.length === 1 && typeof parsed[0] === "object" && parsed[0] !== null) {
            // Single-element wrapper — unwrap directly (most common case).
            parsed = parsed[0];
          } else if (parsed.length > 1 && typeof parsed[0] === "object" && parsed[0] !== null) {
            // Multi-element flat array of entities — the model returned just the characters
            // list without the outer {lorebook:{add:[]}} wrapper. Normalize to {characters:[...]}
            // so the unifiedExtractionSchema normalizer can reshape it.
            parsed = { characters: parsed };
          }
        }

        logger.debug(`Structured request ${phase} attempt ${attempt + 1}: raw response received`, {
          router,
          model: params.model,
          rawLength: response.text.length,
          rawPreview: response.text.slice(0, 300) || "(empty)",
          usage: response.usage,
        });

        if (parsed === null) {
          logger.warn(`Structured request ${phase} attempt ${attempt + 1} failed: empty/unparseable response`, {
            router,
            model: params.model,
            provider: provider ?? null,
            systemPromptLength: params.systemPrompt.length,
            userPromptLength: params.userPrompt.length,
            rawLength: response.text.length,
            rawPreview: response.text.slice(0, 300) || "(empty)",
          });
          if (attempt === retries - 1) {
            throw new Error(`Empty or unparseable response after ${retries} attempts on ${router}`);
          }
          continue;
        }

        logger.debug(`Structured request ${phase} attempt ${attempt + 1}: JSON parsed successfully`, {
          router,
          model: params.model,
          topLevelKeys: Object.keys(parsed),
        });

        const result = schema.safeParse(parsed);

        if (result.success) {
          logger.debug(`Structured request ${phase} attempt ${attempt + 1}: Zod schema validation passed`, {
            router,
            model: params.model,
          });
          return { data: result.data, usage: response.usage, raw: response.text };
        }

        const errorMsg = `Zod Schema Parsing Failed: ${result.error.message}`;
        logger.error(errorMsg, {
          router,
          model: params.model,
          provider: provider ?? null,
          raw: response.text.slice(0, 1000) + (response.text.length > 1000 ? "..." : ""),
          zodErrors: result.error.format(),
        });

        if (attempt === retries - 1) {
          throw new Error(errorMsg);
        }
      } catch (err: any) {
        logger.warn(`Structured request ${phase} attempt ${attempt + 1} threw an exception`, {
          router,
          model: params.model,
          provider: provider ?? null,
          err,
        });
        if (attempt === retries - 1) {
          throw err;
        }
      }
    }

    return null;
  };

  try {
    return await attemptRequest(params.router, params.provider, "primary");
  } catch (primaryErr: any) {
    const fallbackRouter = getStructuredFallbackRouter(params.router);
    const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    const shouldFallback = fallbackRouter && message.toLowerCase().includes("empty or unparseable response");

    if (!shouldFallback) {
      throw primaryErr;
    }

    logger.warn("Structured request primary router failed with empty output; retrying on fallback router", {
      primaryRouter: params.router,
      fallbackRouter,
      model: params.model,
      primaryProvider: params.provider ?? null,
      primaryError: message,
    });

    // Provider identifiers are often router-specific. Let OpenRouter auto-route unless
    // the original request was already using an OpenRouter provider string.
    const fallbackProvider =
      fallbackRouter === "openrouter" || fallbackRouter === "openrouter_external" ? undefined : params.provider;

    return await attemptRequest(fallbackRouter, fallbackProvider, "fallback");
  }
};

export const buildSystemPrompt = (base: string | null | undefined, suffixLines: string[]) => {
  const trimmed = base?.trim();
  return [trimmed, "", ...suffixLines].filter(Boolean).join("\n");
};

export type PromptContextInput = {
  userProfile?: { name?: string | null; description?: string | null } | null;
  ariaPersona?: { name?: string | null; summary?: string | null; content?: string | null } | null;
  conversationTokens?: number;
  messageCount?: number;
};

export const buildPromptContextBlocks = (input: PromptContextInput) => {
  const blocks: string[] = [];
  if (input.conversationTokens || input.messageCount) {
    const metaLines: string[] = [];
    if (input.conversationTokens) metaLines.push(`Approximate tokens: ${input.conversationTokens}`);
    if (input.messageCount) metaLines.push(`Message count: ${input.messageCount}`);
    blocks.push(`<conversationContext>\n${metaLines.join("\n")}\n</conversationContext>`);
  }

  if (input.userProfile?.name) {
    const nameLine = `The user's name is ${input.userProfile.name}.`;
    const description = input.userProfile.description?.trim();
    const content = description ? `${nameLine}\n\n${description}` : nameLine;
    blocks.push(`<userProfile>\n${content}\n</userProfile>`);
  }
  const ariaPersonaText = input.ariaPersona?.summary?.trim() || input.ariaPersona?.content?.trim() || "";
  if (ariaPersonaText) {
    const nameLine = input.ariaPersona?.name ? `Name: ${input.ariaPersona.name}\n\n` : "";
    blocks.push(`<ariaCharacter>\n${nameLine}${ariaPersonaText}\n</ariaCharacter>`);
  }
  return blocks;
};

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface MemoryForXml {
  id: string;
  content: string;
  actualTags: Array<{ name: string; description: string | null }>;
  suggestedTags?: Array<{ name: string; description: string | null }>;
  createdAt?: string;
  chatId?: string | null;
  personaName?: string | null;
  profileName?: string | null;
  importanceScore?: number | null;
}

export function formatMemoryXml(memory: MemoryForXml, indent: number, options?: { includeContext?: boolean }): string {
  const spaces = " ".repeat(indent);
  const innerSpaces = " ".repeat(indent + 2);

  const attrs: string[] = [`id="${escapeXml(memory.id)}"`];
  if (memory.createdAt) attrs.push(`created="${escapeXml(memory.createdAt)}"`);
  if (memory.importanceScore != null) attrs.push(`score="${memory.importanceScore}"`);
  if (options?.includeContext) {
    if (memory.personaName) attrs.push(`persona="${escapeXml(memory.personaName)}"`);
    if (memory.profileName) attrs.push(`profile="${escapeXml(memory.profileName)}"`);
  }

  const lines: string[] = [];
  lines.push(`${spaces}<memory ${attrs.join(" ")}>`);
  lines.push(`${innerSpaces}<content>${escapeXml(memory.content)}</content>`);

  const actualTagNames = memory.actualTags.map((t) => escapeXml(t.name)).join(", ");
  if (actualTagNames) lines.push(`${innerSpaces}<actual_tags>${actualTagNames}</actual_tags>`);

  const suggestedTagNames = (memory.suggestedTags ?? []).map((t) => escapeXml(t.name)).join(", ");
  if (suggestedTagNames) lines.push(`${innerSpaces}<suggested_tags>${suggestedTagNames}</suggested_tags>`);

  lines.push(`${spaces}</memory>`);
  return lines.join("\n");
}

export function formatMemoriesAsXml(
  inScope: MemoryForXml[],
  outOfScope: MemoryForXml[],
  _memoryScope: "GLOBAL" | "PERSONA" | "PERSONA_PROFILE",
  currentChatId?: string,
): string {
  const fromThisChat = currentChatId ? inScope.filter((m) => m.chatId === currentChatId) : [];
  const fromOtherChats = currentChatId ? inScope.filter((m) => m.chatId !== currentChatId) : inScope;

  if (fromThisChat.length === 0 && fromOtherChats.length === 0 && outOfScope.length === 0) {
    return "(no existing memories)";
  }

  const lines: string[] = ["<existing_memories>"];
  if (fromThisChat.length > 0) {
    lines.push(
      `  <from_this_chat count="${fromThisChat.length}" note="Extracted from this conversation. You may create/update/supersede/merge these. Cross-chat memories may only be reinforced.">`,
    );
    for (const m of fromThisChat) lines.push(formatMemoryXml(m, 4));
    lines.push("  </from_this_chat>");
  }
  if (fromOtherChats.length > 0) {
    lines.push(`  <from_other_chats count="${fromOtherChats.length}">`);
    for (const m of fromOtherChats) lines.push(formatMemoryXml(m, 4));
    lines.push("  </from_other_chats>");
  }
  if (outOfScope.length > 0) {
    lines.push(
      `  <other_contexts count="${outOfScope.length}" note="Check for duplicates before creating new memories">`,
    );
    for (const m of outOfScope) lines.push(formatMemoryXml(m, 4, { includeContext: true }));
    lines.push("  </other_contexts>");
  }
  lines.push("</existing_memories>");
  return lines.join("\n");
}
