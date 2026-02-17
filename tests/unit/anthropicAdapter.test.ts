import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { mockAnthropicResponse, mockAnthropicStreamChunks } from '../fixtures/mockResponses.js';

describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter('test-key');

  describe('translateRequest', () => {
    it('extracts system messages to top-level system field', () => {
      const result = adapter.translateRequest(
        {
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
          ],
        },
        'claude-opus-4-6'
      );
      expect(result.system).toBe('You are helpful.');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.role).toBe('user');
    });

    it('sets default max_tokens of 4096 when not provided', () => {
      const result = adapter.translateRequest(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        'claude-opus-4-6'
      );
      expect(result.max_tokens).toBe(4096);
    });

    it('uses provided max_tokens', () => {
      const result = adapter.translateRequest(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 },
        'claude-opus-4-6'
      );
      expect(result.max_tokens).toBe(1000);
    });

    it('drops unsupported fields (frequency_penalty, presence_penalty)', () => {
      const result = adapter.translateRequest(
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          frequency_penalty: 0.5,
          presence_penalty: 0.5,
        },
        'claude-opus-4-6'
      );
      expect(result).not.toHaveProperty('frequency_penalty');
      expect(result).not.toHaveProperty('presence_penalty');
    });

    it('converts stop array correctly', () => {
      const result = adapter.translateRequest(
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stop: ['END', 'STOP'],
        },
        'claude-opus-4-6'
      );
      expect(result.stop_sequences).toEqual(['END', 'STOP']);
    });

    it('converts stop string to array', () => {
      const result = adapter.translateRequest(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stop: 'END' },
        'claude-opus-4-6'
      );
      expect(result.stop_sequences).toEqual(['END']);
    });
  });

  describe('translateResponse', () => {
    it('maps Anthropic response to OpenAI format', () => {
      const result = adapter.translateResponse(
        mockAnthropicResponse as Parameters<typeof adapter.translateResponse>[0],
        'gpt-4o'
      ) as Record<string, unknown>;

      expect(result['object']).toBe('chat.completion');
      expect(result['model']).toBe('gpt-4o'); // preserves requested model
      const choices = result['choices'] as Array<Record<string, unknown>>;
      expect(choices).toHaveLength(1);
      const message = choices[0]?.['message'] as Record<string, unknown>;
      expect(message?.['content']).toBe('Hello from Anthropic!');
      const usage = result['usage'] as Record<string, number>;
      expect(usage?.['prompt_tokens']).toBe(10);
      expect(usage?.['completion_tokens']).toBe(5);
      expect(usage?.['total_tokens']).toBe(15);
    });

    it('maps stop reasons correctly', () => {
      const result = adapter.translateResponse(
        { ...mockAnthropicResponse, stop_reason: 'max_tokens' } as Parameters<typeof adapter.translateResponse>[0],
        'gpt-4o'
      ) as Record<string, unknown>;
      const choices = result['choices'] as Array<Record<string, unknown>>;
      expect(choices[0]?.['finish_reason']).toBe('length');
    });
  });

  describe('convertStreamLine', () => {
    it('converts content_block_delta to OpenAI chunk', () => {
      const line = mockAnthropicStreamChunks[2]; // content_block_delta with "Hello"
      if (!line) return;
      const result = adapter.convertStreamLine(line.replace('\n\n', ''), 'gpt-4o');
      expect(result).toBeTruthy();
      if (!result) return;
      const parsed = JSON.parse(result.replace('data: ', '').trim()) as Record<string, unknown>;
      expect(parsed['object']).toBe('chat.completion.chunk');
      const choices = parsed['choices'] as Array<Record<string, unknown>>;
      const delta = choices[0]?.['delta'] as Record<string, unknown>;
      expect(delta?.['content']).toBe('Hello');
    });

    it('converts message_stop to [DONE]', () => {
      const line = 'data: {"type":"message_stop"}';
      const result = adapter.convertStreamLine(line, 'gpt-4o');
      expect(result).toBe('data: [DONE]\n\n');
    });

    it('returns null for non-data lines', () => {
      expect(adapter.convertStreamLine('event: message_start', 'gpt-4o')).toBeNull();
      expect(adapter.convertStreamLine('', 'gpt-4o')).toBeNull();
    });

    it('returns null for unknown event types', () => {
      const line = 'data: {"type":"message_start","message":{}}';
      expect(adapter.convertStreamLine(line, 'gpt-4o')).toBeNull();
    });
  });
});
