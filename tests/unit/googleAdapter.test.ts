import { describe, it, expect } from 'vitest';
import { GoogleAdapter } from '../../src/providers/google.js';
import { mockGoogleResponse } from '../fixtures/mockResponses.js';

describe('GoogleAdapter', () => {
  const adapter = new GoogleAdapter('test-key');

  describe('translateRequest', () => {
    it('converts OpenAI messages to Google contents format', () => {
      const result = adapter.translateRequest({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
      });

      expect(result.contents).toHaveLength(3);
      expect(result.contents[0]?.role).toBe('user');
      expect(result.contents[1]?.role).toBe('model'); // assistant → model
      expect(result.contents[2]?.role).toBe('user');
    });

    it('extracts system messages to systemInstruction', () => {
      const result = adapter.translateRequest({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
      });

      expect(result.systemInstruction?.parts[0]?.text).toBe('You are a helpful assistant.');
      expect(result.contents).toHaveLength(1);
    });

    it('maps generationConfig fields', () => {
      const result = adapter.translateRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        max_tokens: 1000,
        top_p: 0.9,
        n: 2,
      });

      expect(result.generationConfig?.temperature).toBe(0.7);
      expect(result.generationConfig?.maxOutputTokens).toBe(1000);
      expect(result.generationConfig?.topP).toBe(0.9);
      expect(result.generationConfig?.candidateCount).toBe(2);
    });

    it('maps json_object response_format to responseMimeType', () => {
      const result = adapter.translateRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      });

      expect(result.generationConfig?.responseMimeType).toBe('application/json');
    });

    it('omits generationConfig when no config fields provided', () => {
      const result = adapter.translateRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(result.generationConfig).toBeUndefined();
    });
  });

  describe('translateResponse', () => {
    it('maps Google response to OpenAI format', () => {
      const result = adapter.translateResponse(
        mockGoogleResponse as Parameters<typeof adapter.translateResponse>[0],
        'gpt-4o'
      ) as Record<string, unknown>;

      expect(result['object']).toBe('chat.completion');
      expect(result['model']).toBe('gpt-4o');
      const choices = result['choices'] as Array<Record<string, unknown>>;
      expect(choices).toHaveLength(1);
      const message = choices[0]?.['message'] as Record<string, unknown>;
      expect(message?.['content']).toBe('Hello from Google!');
      const usage = result['usage'] as Record<string, number>;
      expect(usage?.['prompt_tokens']).toBe(10);
      expect(usage?.['completion_tokens']).toBe(4);
      expect(usage?.['total_tokens']).toBe(14);
    });

    it('maps SAFETY finish reason to content_filter', () => {
      const response = {
        ...mockGoogleResponse,
        candidates: [
          { ...mockGoogleResponse.candidates[0], finishReason: 'SAFETY' },
        ],
      };
      const result = adapter.translateResponse(
        response as Parameters<typeof adapter.translateResponse>[0],
        'gpt-4o'
      ) as Record<string, unknown>;
      const choices = result['choices'] as Array<Record<string, unknown>>;
      expect(choices[0]?.['finish_reason']).toBe('content_filter');
    });
  });

  describe('convertStreamLine', () => {
    it('converts Google SSE line to OpenAI chunk format', () => {
      const line = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6},"modelVersion":"gemini-1.5-pro"}';
      const result = adapter.convertStreamLine(line, 'gpt-4o');
      expect(result).toBeTruthy();
      if (!result) return;
      const parsed = JSON.parse(result.replace('data: ', '').trim()) as Record<string, unknown>;
      expect(parsed['object']).toBe('chat.completion.chunk');
      const choices = parsed['choices'] as Array<Record<string, unknown>>;
      const delta = choices[0]?.['delta'] as Record<string, unknown>;
      expect(delta?.['content']).toBe('Hello');
    });

    it('returns null for non-data lines', () => {
      expect(adapter.convertStreamLine('', 'gpt-4o')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(adapter.convertStreamLine('data: {invalid json}', 'gpt-4o')).toBeNull();
    });
  });
});
