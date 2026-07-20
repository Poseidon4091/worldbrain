// Token/char limits live in ONE place: src/config/limits.ts. No purpose-specific
// token budgets — every call gets DEFAULT_MAX_OUTPUT_TOKENS unless the user
// configured a template override. Import it from config/limits.js.

export type TextContentBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
};

export type ImageContentBlock = {
  type: "image_url";
  image_url: { url: string; detail: "auto" | "low" | "high" };
};

export type ContentBlock = TextContentBlock | ImageContentBlock;

/** Content is either a plain string or a structured block array (for cache markers + vision) */
export type MessageContent = string | ContentBlock[];

/** Extract plain text from MessageContent — handles both string and mixed block arrays */
export function extractTextContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContentBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** OpenRouter reasoning detail block — pass through unmodified for cache preservation. */
export interface ReasoningDetail {
  type: string;
  id?: string | null;
  format?: string;
  index?: number;
  text?: string;
  signature?: string | null;
  summary?: string;
  data?: string;
  [key: string]: unknown;
}

export interface ModelRequest {
  model: string;
  provider?: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: MessageContent;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
    /** Raw reasoning_details blocks from OpenRouter — preserve unmodified for Anthropic cache continuity */
    reasoning_details?: ReasoningDetail[];
  }>;
  temperature?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  responseFormat?: "text" | "json" | { type: "json_schema"; jsonSchema: Record<string, any> };
  abortSignal?: AbortSignal;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
    cache_control?: { type: "ephemeral" };
  }>;
  broadcast?: { sessionId: string; trace: Record<string, unknown> };
}

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** Accumulated raw reasoning_details blocks — called once after stream ends, before onFinish. */
  onReasoningDetails?: (details: ReasoningDetail[]) => void;
  onToolCall?: (toolCall: { id: string; name: string; arguments: string }) => void;
  onFinish: (usage: TokenUsage) => void;
  onError: (error: Error) => void;
  /** Send an arbitrary server event to the client (survives past onFinish). */
  sendEvent?: (msg: Record<string, unknown>) => void;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
}

export interface ModelClient {
  streamCompletion(req: ModelRequest, callbacks: StreamCallbacks): Promise<void>;
  createCompletion(req: ModelRequest): Promise<{
    text: string;
    toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    usage: TokenUsage;
  }>;
  listModels(): Promise<ModelInfo[]>;
}
