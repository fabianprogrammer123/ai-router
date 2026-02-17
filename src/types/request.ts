/**
 * Normalized internal request/response shapes used across the router.
 * All provider adapters translate to/from these types.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  content: string | ChatMessagePart[] | null;
  name?: string;
  tool_call_id?: string;
}

export interface ChatMessagePart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface NormalizedChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  user?: string;
  response_format?: { type: 'text' | 'json_object' };
  seed?: number;
}

export interface ChatChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
  };
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  logprobs?: unknown;
}

export interface ChatStreamDelta {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
  };
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface NormalizedChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: UsageInfo;
}

export interface NormalizedImageRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: 'url' | 'b64_json';
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  user?: string;
}

export interface ImageData {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface NormalizedImageResponse {
  created: number;
  data: ImageData[];
}

export interface NormalizedEmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

export interface EmbeddingData {
  index: number;
  object: 'embedding';
  embedding: number[];
}

export interface NormalizedEmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Raw HTTP response from a provider call
 */
export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  stream?: AsyncIterable<string>;
}

/**
 * Error thrown by provider adapters
 */
export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    public readonly headers: Record<string, string>,
    message: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
