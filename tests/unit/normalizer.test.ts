import { describe, it, expect } from 'vitest';
import { normalizeStream } from '../../src/streaming/normalizer.js';
import { Provider } from '../../src/types/provider.js';
import { mockStreamChunks, mockAnthropicStreamChunks } from '../fixtures/mockResponses.js';

async function collectStream(gen: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

async function* arrayToAsyncIterable(arr: string[]): AsyncIterable<string> {
  for (const item of arr) {
    yield item;
  }
}

describe('normalizeStream', () => {
  describe('OpenAI (pass-through)', () => {
    it('passes through OpenAI chunks unchanged', async () => {
      const input = mockStreamChunks;
      const gen = normalizeStream(arrayToAsyncIterable(input), Provider.OpenAI, 'gpt-4o');
      const output = await collectStream(gen);
      expect(output).toEqual(input);
    });
  });

  describe('Anthropic', () => {
    it('converts Anthropic stream to OpenAI format', async () => {
      const gen = normalizeStream(
        arrayToAsyncIterable(mockAnthropicStreamChunks),
        Provider.Anthropic,
        'gpt-4o'
      );
      const output = await collectStream(gen);

      // Should contain some OpenAI-formatted chunks
      const dataChunks = output.filter((c) => c.startsWith('data: ') && !c.includes('[DONE]'));
      expect(dataChunks.length).toBeGreaterThan(0);

      // Should end with [DONE]
      const doneChunk = output.find((c) => c.includes('[DONE]'));
      expect(doneChunk).toBeTruthy();
    });

    it('converts content_block_delta events', async () => {
      const stream = ['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}\n\n'];
      const gen = normalizeStream(arrayToAsyncIterable(stream), Provider.Anthropic, 'gpt-4o');
      const output = await collectStream(gen);

      const parsed = output
        .filter((c) => c.startsWith('data: ') && !c.includes('[DONE]'))
        .map((c) => JSON.parse(c.slice(6).trim()) as Record<string, unknown>);

      expect(parsed).toHaveLength(1);
      const choices = parsed[0]?.['choices'] as Array<Record<string, unknown>>;
      const delta = choices[0]?.['delta'] as Record<string, unknown>;
      expect(delta?.['content']).toBe('Hello world');
    });
  });
});
