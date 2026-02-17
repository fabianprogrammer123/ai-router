/**
 * Mock provider response fixtures for tests
 */

export const mockOpenAIChatResponse = {
  id: 'chatcmpl-test123',
  object: 'chat.completion',
  created: 1699000000,
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Hello! How can I help you today?',
      },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 9,
    total_tokens: 19,
  },
};

export const mockAnthropicResponse = {
  id: 'msg_test123',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello from Anthropic!' }],
  model: 'claude-opus-4-6',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
  },
};

export const mockGoogleResponse = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'Hello from Google!' }],
      },
      finishReason: 'STOP',
      index: 0,
    },
  ],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 4,
    totalTokenCount: 14,
  },
  modelVersion: 'gemini-1.5-pro-001',
};

export const mockOpenAIRateLimitHeaders: Record<string, string> = {
  'x-ratelimit-remaining-requests': '100',
  'x-ratelimit-remaining-tokens': '50000',
  'x-ratelimit-reset-requests': '30s',
  'x-ratelimit-reset-tokens': '1s',
};

export const mockAnthropicRateLimitHeaders: Record<string, string> = {
  'anthropic-ratelimit-requests-remaining': '50',
  'anthropic-ratelimit-tokens-remaining': '25000',
  'anthropic-ratelimit-requests-reset': new Date(Date.now() + 30000).toISOString(),
  'anthropic-ratelimit-tokens-reset': new Date(Date.now() + 1000).toISOString(),
};

export const mockStreamChunks = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1699000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1699000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1699000000,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

export const mockAnthropicStreamChunks = [
  'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" World"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
  'data: {"type":"message_stop"}\n\n',
];
