import { env } from "../../env.js";

/**
 * Minimal, OpenAI-compatible model dispatch for worldbrain.
 *
 * Replaces Aria's multi-provider BYOK router with a single clean client that talks to any
 * OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, nanoGPT, Together, a local
 * vLLM, …). The provider is selected by `RouterType`, each mapping to a base URL + key from env.
 * The public surface (RouterType, createModelClient, createModelClientWithKey, ModelClient)
 * matches what structuredRequest.ts expects, so that file is used verbatim.
 */

export type RouterType = "openai" | "openrouter" | "openrouter_external" | "nanogpt" | "nanogpt_external" | "custom";

export interface CompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionParams {
  model: string;
  provider?: string;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  responseFormat?: "text" | "json" | { type: "json_schema"; jsonSchema: Record<string, any> };
  messages: CompletionMessage[];
}

export interface CompletionResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface ModelClient {
  createCompletion(params: CompletionParams): Promise<CompletionResult>;
}

interface Endpoint {
  baseUrl: string;
  apiKey: string | undefined;
}

function endpointFor(router: RouterType): Endpoint {
  switch (router) {
    case "openai":
      return { baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY };
    case "openrouter":
    case "openrouter_external":
      return { baseUrl: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY };
    case "nanogpt":
    case "nanogpt_external":
      return { baseUrl: env.NANOGPT_BASE_URL ?? "https://nano-gpt.com/api/v1", apiKey: env.NANOGPT_API_KEY };
    default:
      return { baseUrl: env.LLM_BASE_URL ?? "https://api.openai.com/v1", apiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY };
  }
}

function makeClient(baseUrl: string, apiKey: string | undefined): ModelClient {
  return {
    async createCompletion(params: CompletionParams): Promise<CompletionResult> {
      const body: Record<string, any> = {
        model: params.model,
        messages: params.messages,
      };
      if (params.temperature != null) body.temperature = params.temperature;
      if (params.maxOutputTokens != null) body.max_tokens = params.maxOutputTokens;
      if (params.provider) body.provider = { order: [params.provider] }; // OpenRouter-style provider hint
      if (params.responseFormat === "json") body.response_format = { type: "json_object" };
      else if (typeof params.responseFormat === "object" && params.responseFormat.type === "json_schema") {
        body.response_format = { type: "json_schema", json_schema: params.responseFormat.jsonSchema };
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`LLM API error (${res.status}): ${errBody.slice(0, 500)}`);
      }

      const data: any = await res.json();
      const text: string = data.choices?.[0]?.message?.content ?? "";
      const u = data.usage;
      const usage = u
        ? {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
            totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
          }
        : null;
      return { text, usage };
    },
  };
}

export function createModelClient(router: RouterType): ModelClient {
  const { baseUrl, apiKey } = endpointFor(router);
  return makeClient(baseUrl, apiKey);
}

export function createModelClientWithKey(router: RouterType, apiKey: string): ModelClient {
  const { baseUrl } = endpointFor(router);
  return makeClient(baseUrl, apiKey);
}
