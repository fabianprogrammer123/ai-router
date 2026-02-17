import { request as undiciRequest } from 'undici';
import { type Capability } from '../types/provider.js';
import { type ProviderResponse, ProviderError, type ChatMessage, type NormalizedChatRequest, type NormalizedImageRequest } from '../types/request.js';
import { BaseProviderAdapter } from './base.js';
import { normalizeHeaders } from '../utils/headers.js';

const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com';

interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

interface GooglePart {
  text: string;
}

interface GoogleRequest {
  contents: GoogleContent[];
  systemInstruction?: {
    parts: GooglePart[];
  };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    stopSequences?: string[];
    candidateCount?: number;
    responseMimeType?: string;
  };
}

interface GoogleResponseCandidate {
  content: {
    role: string;
    parts: GooglePart[];
  };
  finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
  index: number;
}

interface GoogleResponse {
  candidates: GoogleResponseCandidate[];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion: string;
}

/**
 * Google (Gemini) adapter.
 * Translates OpenAI-format requests/responses to/from Google's Generative Language API.
 */
export class GoogleAdapter extends BaseProviderAdapter {
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
    switch (capability) {
      case 'chat':
        return this.handleChat(
          body as NormalizedChatRequest,
          requestedModel,
          providerModel,
          signal
        );
      case 'images':
        return this.handleImages(
          body as NormalizedImageRequest,
          requestedModel,
          providerModel,
          signal
        );
      case 'embeddings':
        throw new ProviderError(
          'google',
          400,
          {},
          'Google adapter does not support embeddings capability'
        );
      default:
        throw new ProviderError('google', 400, {}, `Unknown capability: ${String(capability)}`);
    }
  }

  private async handleChat(
    body: NormalizedChatRequest,
    requestedModel: string,
    providerModel: string,
    signal: AbortSignal
  ): Promise<ProviderResponse> {
    const googleBody = this.translateRequest(body);

    const isStreaming = body.stream === true;
    const endpoint = isStreaming ? 'streamGenerateContent' : 'generateContent';
    const streamParam = isStreaming ? '&alt=sse' : '';
    const url = `${GOOGLE_BASE_URL}/v1beta/models/${providerModel}:${endpoint}?key=${this.apiKey}${streamParam}`;

    const response = await undiciRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(googleBody),
      signal,
    });

    const headers = normalizeHeaders(response.headers as Record<string, string | string[]>);

    if (!response.statusCode || response.statusCode >= 400) {
      const errorBody = await response.body.json().catch(() => ({}));
      throw new ProviderError(
        'google',
        response.statusCode ?? 500,
        headers,
        `Google API error: ${response.statusCode}`,
        errorBody
      );
    }

    if (isStreaming) {
      return {
        status: response.statusCode,
        headers,
        body: null,
        stream: this.bodyToAsyncIterable(response.body as AsyncIterable<Buffer>, requestedModel),
      };
    }

    const googleResponse = await response.body.json() as GoogleResponse;
    const openAIResponse = this.translateResponse(googleResponse, requestedModel);

    return {
      status: 200,
      headers,
      body: openAIResponse,
    };
  }

  private async handleImages(
    body: NormalizedImageRequest,
    _requestedModel: string,
    _providerModel: string,
    signal: AbortSignal
  ): Promise<ProviderResponse> {
    const url = `${GOOGLE_BASE_URL}/v1beta/models/imagen-3.0-generate-001:predict?key=${this.apiKey}`;

    const googleBody = {
      instances: [{ prompt: body.prompt }],
      parameters: {
        sampleCount: body.n ?? 1,
      },
    };

    const response = await undiciRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(googleBody),
      signal,
    });

    const headers = normalizeHeaders(response.headers as Record<string, string | string[]>);

    if (!response.statusCode || response.statusCode >= 400) {
      const errorBody = await response.body.json().catch(() => ({}));
      throw new ProviderError(
        'google',
        response.statusCode ?? 500,
        headers,
        `Google Images API error: ${response.statusCode}`,
        errorBody
      );
    }

    const googleResponse = await response.body.json() as { predictions: Array<{ bytesBase64Encoded: string }> };

    const data = googleResponse.predictions.map((p) => ({
      b64_json: p.bytesBase64Encoded,
      revised_prompt: body.prompt,
    }));

    return {
      status: 200,
      headers,
      body: {
        created: this.currentTimestamp(),
        data,
      },
    };
  }

  /**
   * Translate OpenAI request → Google format
   */
  translateRequest(body: NormalizedChatRequest): GoogleRequest {
    const messages = body.messages ?? [];

    // Extract system messages
    const systemMessages = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean);

    // Convert non-system messages
    const contents: GoogleContent[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => this.convertMessage(m));

    const googleRequest: GoogleRequest = {
      contents,
    };

    if (systemMessages.length > 0) {
      googleRequest.systemInstruction = {
        parts: [{ text: systemMessages.join('\n\n') }],
      };
    }

    const generationConfig: GoogleRequest['generationConfig'] = {};

    if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
    if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens;
    if (body.top_p !== undefined) generationConfig.topP = body.top_p;
    if (body.n !== undefined) generationConfig.candidateCount = body.n;

    if (body.stop) {
      generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    }

    if (body.response_format?.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json';
    }

    if (Object.keys(generationConfig).length > 0) {
      googleRequest.generationConfig = generationConfig;
    }

    return googleRequest;
  }

  private convertMessage(m: ChatMessage): GoogleContent {
    const role: GoogleContent['role'] = m.role === 'assistant' ? 'model' : 'user';

    if (typeof m.content === 'string') {
      return { role, parts: [{ text: m.content }] };
    }

    if (Array.isArray(m.content)) {
      const parts = m.content
        .filter((p) => p.type === 'text')
        .map((p) => ({ text: p.text ?? '' }));
      return { role, parts };
    }

    return { role, parts: [{ text: '' }] };
  }

  /**
   * Translate Google response → OpenAI format
   */
  translateResponse(googleResp: GoogleResponse, requestedModel: string): unknown {
    const candidates = googleResp.candidates ?? [];

    const choices = candidates.map((c, index) => ({
      index,
      message: {
        role: 'assistant',
        content: c.content?.parts?.[0]?.text ?? null,
      },
      finish_reason: this.mapFinishReason(c.finishReason),
      logprobs: null,
    }));

    return {
      id: this.buildId('chatcmpl'),
      object: 'chat.completion',
      created: this.currentTimestamp(),
      model: requestedModel,
      choices,
      usage: {
        prompt_tokens: googleResp.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: googleResp.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: googleResp.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }

  private mapFinishReason(reason: string): string {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
        return 'content_filter';
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

    yield 'data: [DONE]\n\n';
  }

  /**
   * Convert a Google SSE line to OpenAI SSE format
   */
  convertStreamLine(line: string, requestedModel: string): string | null {
    if (!line.startsWith('data: ')) return null;

    const dataStr = line.slice(6).trim();
    if (!dataStr || dataStr === '[DONE]') return null;

    let data: GoogleResponse;
    try {
      data = JSON.parse(dataStr) as GoogleResponse;
    } catch {
      return null;
    }

    const candidate = data.candidates?.[0];
    if (!candidate) return null;

    const text = candidate.content?.parts?.[0]?.text;
    const finishReason = candidate.finishReason
      ? this.mapFinishReason(candidate.finishReason)
      : null;

    const chunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: this.currentTimestamp(),
      model: requestedModel,
      choices: [
        {
          index: 0,
          delta: text !== undefined ? { content: text } : {},
          finish_reason: finishReason,
        },
      ],
    };

    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
}
