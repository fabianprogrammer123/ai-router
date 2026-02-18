import { randomUUID } from 'crypto';

/**
 * Converts an async iterable of OpenAI SSE chunks into Anthropic SSE event format.
 *
 * Used by the /v1/messages endpoint so the Anthropic SDK (and Claude Code CLI)
 * receive the exact streaming format they expect, regardless of which underlying
 * provider actually served the request.
 *
 * OpenAI chunk format (input):
 *   data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
 *
 * Anthropic event format (output):
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 *   event: content_block_stop
 *   data: {"type":"content_block_stop","index":0}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 */
export async function* toAnthropicStream(
  openAIChunks: AsyncIterable<string>,
  msgId: string,
  requestedModel: string
): AsyncIterable<string> {
  let contentBlockStarted = false;
  let outputTokens = 0;
  let stopReason: string | null = null;

  // Emit message_start immediately so the client knows we're alive
  const messageStart = {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: requestedModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 1 },
    },
  };
  yield `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`;
  yield `event: ping\ndata: {"type":"ping"}\n\n`;

  for await (const line of openAIChunks) {
    if (!line.startsWith('data: ')) continue;

    const dataStr = line.slice(6).trim();
    if (dataStr === '[DONE]') break;
    if (!dataStr) continue;

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      continue;
    }

    const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) continue;

    const delta = choice['delta'] as Record<string, unknown> | undefined;
    const finishReason = choice['finish_reason'] as string | null | undefined;

    const content = delta?.['content'] as string | undefined;

    // Emit content_block_start before the first text delta
    if (content && !contentBlockStarted) {
      yield `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`;
      contentBlockStarted = true;
    }

    if (content) {
      outputTokens++;
      const blockDelta = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: content },
      };
      yield `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`;
    }

    if (finishReason) {
      stopReason = mapFinishReason(finishReason);
    }
  }

  // Close the content block
  if (contentBlockStarted) {
    yield `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`;
  }

  // Emit message_delta with stop reason and token count
  const messageDelta = {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
  yield `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`;

  // Emit message_stop — signals end of stream to Anthropic SDK
  yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
}

/**
 * Generate a message ID in Anthropic format (msg_ prefix)
 */
export function generateMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 */
export function mapFinishReason(openAIReason: string): string {
  switch (openAIReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

/**
 * Convert an OpenAI chat completion response body to Anthropic messages format.
 * Used for non-streaming /v1/messages responses.
 */
export function openAIResponseToAnthropic(
  openAIBody: Record<string, unknown>,
  requestedModel: string
): Record<string, unknown> {
  const choices = openAIBody['choices'] as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.['message'] as Record<string, unknown> | undefined;
  const content = (message?.['content'] as string | null) ?? '';
  const finishReason = choice?.['finish_reason'] as string | undefined;
  const usage = openAIBody['usage'] as Record<string, number> | undefined;
  const id = (openAIBody['id'] as string | undefined) ?? generateMessageId();

  return {
    id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    model: requestedModel,
    stop_reason: mapFinishReason(finishReason ?? 'stop'),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.['prompt_tokens'] ?? 0,
      output_tokens: usage?.['completion_tokens'] ?? 0,
    },
  };
}
