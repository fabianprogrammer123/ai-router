import { request as undiciRequest } from 'undici';
import { type Capability } from '../types/provider.js';
import { type ProviderResponse, ProviderError } from '../types/request.js';
import { BaseProviderAdapter } from './base.js';
import { normalizeHeaders } from '../utils/headers.js';

const OPENAI_BASE_URL = 'https://api.openai.com';

/**
 * OpenAI adapter — minimal translation needed since our wire format matches OpenAI exactly.
 * Handles chat completions, image generation, and embeddings.
 */
export class OpenAIAdapter extends BaseProviderAdapter {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async call(
    capability: Capability,
    _requestedModel: string,
    providerModel: string,
    signal: AbortSignal,
    body?: unknown
  ): Promise<ProviderResponse> {
    const path = this.getPath(capability);
    const requestBody = this.prepareBody(body, providerModel);

    const response = await undiciRequest(`${OPENAI_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    const headers = normalizeHeaders(response.headers as Record<string, string | string[]>);

    if (!response.statusCode || response.statusCode >= 400) {
      const errorBody = await response.body.json().catch(() => ({}));
      throw new ProviderError(
        'openai',
        response.statusCode ?? 500,
        headers,
        `OpenAI API error: ${response.statusCode}`,
        errorBody
      );
    }

    // For streaming, pass the body stream through
    const isStreaming = typeof body === 'object' && body !== null && (body as Record<string, unknown>)['stream'] === true;

    if (isStreaming) {
      return {
        status: response.statusCode,
        headers,
        body: null,
        stream: this.bodyToAsyncIterable(response.body as AsyncIterable<Buffer>),
      };
    }

    const responseBody = await response.body.json();
    return {
      status: response.statusCode,
      headers,
      body: responseBody,
    };
  }

  private getPath(capability: Capability): string {
    switch (capability) {
      case 'chat':
        return '/v1/chat/completions';
      case 'images':
        return '/v1/images/generations';
      case 'embeddings':
        return '/v1/embeddings';
      default:
        return '/v1/chat/completions';
    }
  }

  private prepareBody(body: unknown, providerModel: string): unknown {
    if (typeof body !== 'object' || body === null) return body;
    return { ...(body as Record<string, unknown>), model: providerModel };
  }

  private async *bodyToAsyncIterable(
    body: AsyncIterable<Buffer>
  ): AsyncIterable<string> {
    for await (const chunk of body) {
      yield chunk.toString('utf-8');
    }
  }
}
