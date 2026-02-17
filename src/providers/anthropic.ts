import { request as undiciRequest } from 'undici';
import { type Capability } from '../types/provider.js';
import { type ProviderResponse, ProviderError, type ChatMessage, type NormalizedChatRequest } from '../types/request.js';
import { BaseProviderAdapter } from './base.js';
import { normalizeHeaders } from '../utils/headers.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text';
  text: string;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | undefined;
  max_tokens: number;
  temperature?: number | undefined;
  top_p?: number | undefined;
  stop_sequences?: string[] | undefined;
  stream?: boolean | undefined;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Anthropic (Claude) adapter.
 * Translates OpenAI-format requests/responses to/from Anthropic's API.
 */
export class AnthropicAdapter extends BaseProviderAdapter {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async call(
    capability: Capability,
    requestedModel: string,
    providerModel: string,
    signal: AbortSignal,
    body?: unknown
  ): Promise<ProviderResponse> {
    if (capability !== 'chat') {
      throw new ProviderError(
        'anthropic',
        400,
        {},
        `Anthropic adapter does not support capability: ${capability}`
      );
    }

    const openAIBody = body as NormalizedChatRequest;
    const anthropicBody = this.translateRequest(openAIBody, providerModel);

    const response = await undiciRequest(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(anthropicBody),
      signal,
    });

    const headers = normalizeHeaders(response.headers as Record<string, string | string[]>);

    if (!response.statusCode || response.statusCode >= 400) {
      const errorBody = await response.body.json().catch(() => ({}));
      throw new ProviderError(
        'anthropic',
        response.statusCode ?? 500,
        headers,
        `Anthropic API error: ${response.statusCode}`,
        errorBody
      );
    }

    if (openAIBody.stream) {
      return {
        status: response.statusCode,
        headers,
        body: null,
        stream: this.bodyToAsyncIterable(response.body as AsyncIterable<Buffer>, requestedModel),
      };
    }

    const anthropicResponse = await response.body.json() as AnthropicResponse;
    const openAIResponse = this.translateResponse(anthropicResponse, requestedModel);

    return {
      status: 200,
      headers,
      body: openAIResponse,
    };
  }

  /**
   * Translate OpenAI request format → Anthropic format
   */
  translateRequest(body: NormalizedChatRequest, providerModel: string): AnthropicRequest {
    const messages = body.messages ?? [];

    // Extract system messages
    const systemMessages = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n\n');

    // Convert non-system messages
    const convertedMessages: AnthropicMessage[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => this.convertMessage(m));

    const anthropicRequest: AnthropicRequest = {
      model: providerModel,
      messages: convertedMessages,
      max_tokens: body.max_tokens ?? 4096, // Required by Anthropic
      stream: body.stream,
    };

    if (systemMessages) {
      anthropicRequest.system = systemMessages;
    }

    if (body.temperature !== undefined) {
      anthropicRequest.temperature = body.temperature;
    }

    if (body.top_p !== undefined) {
      anthropicRequest.top_p = body.top_p;
    }

    if (body.stop) {
      anthropicRequest.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    }

    // Note: frequency_penalty, presence_penalty, logprobs are not supported by Anthropic
    // They are intentionally dropped here

    return anthropicRequest;
  }

  private convertMessage(m: ChatMessage): AnthropicMessage {
    const role = m.role === 'assistant' ? 'assistant' : 'user';

    if (typeof m.content === 'string') {
      return { role, content: m.content };
    }

    if (Array.isArray(m.content)) {
      const textParts = m.content
        .filter((p) => p.type === 'text')
        .map((p) => ({ type: 'text' as const, text: p.text ?? '' }));
      return { role, content: textParts };
    }

    return { role, content: '' };
  }

  /**
   * Translate Anthropic response → OpenAI format
   */
  translateResponse(anthropicResp: AnthropicResponse, requestedModel: string): unknown {
    const content = anthropicResp.content[0]?.text ?? null;
    const finishReason = this.mapStopReason(anthropicResp.stop_reason);

    return {
      id: anthropicResp.id,
      object: 'chat.completion',
      created: this.currentTimestamp(),
      model: requestedModel, // Always return the original requested model
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: anthropicResp.usage.input_tokens,
        completion_tokens: anthropicResp.usage.output_tokens,
        total_tokens: anthropicResp.usage.input_tokens + anthropicResp.usage.output_tokens,
      },
    };
  }

  private mapStopReason(reason: string): string {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'stop_sequence':
        return 'stop';
      default:
        return 'stop';
    }
  }

  private async *bodyToAsyncIterable(
    body: AsyncIterable<Buffer>,
    requestedModel: string
  ): AsyncIterable<string> {
    let buffer = '';
    for await (const chunk of body) {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const converted = this.convertStreamLine(line, requestedModel);
        if (converted) yield converted;
      }
    }

    if (buffer.trim()) {
      const converted = this.convertStreamLine(buffer, requestedModel);
      if (converted) yield converted;
    }
  }

  /**
   * Convert a single Anthropic SSE line to OpenAI SSE format
   * Anthropic events:
   *   event: content_block_delta → delta.type="text_delta", delta.text="..."
   *   event: message_delta → delta.stop_reason
   *   event: message_stop → done
   */
  convertStreamLine(line: string, requestedModel: string): string | null {
    if (!line.startsWith('data: ')) return null;

    const dataStr = line.slice(6).trim();
    if (!dataStr) return null;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      return null;
    }

    const eventType = data['type'] as string | undefined;

    switch (eventType) {
      case 'content_block_delta': {
        const delta = data['delta'] as Record<string, unknown> | undefined;
        if (!delta || delta['type'] !== 'text_delta') return null;

        const chunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: this.currentTimestamp(),
          model: requestedModel,
          choices: [
            {
              index: 0,
              delta: { content: delta['text'] as string },
              finish_reason: null,
            },
          ],
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
      }

      case 'message_delta': {
        const delta = data['delta'] as Record<string, unknown> | undefined;
        if (!delta) return null;

        const stopReason = delta['stop_reason'] as string | undefined;
        const finishReason = stopReason ? this.mapStopReason(stopReason) : null;

        const chunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: this.currentTimestamp(),
          model: requestedModel,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
      }

      case 'message_stop':
        return 'data: [DONE]\n\n';

      default:
        return null;
    }
  }
}
