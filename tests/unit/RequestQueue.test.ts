import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestQueue } from '../../src/core/RequestQueue.js';
import { Capability, Provider } from '../../src/types/provider.js';
import type { RouterResult } from '../../src/types/routing.js';

function makeMockResult(): RouterResult {
  return {
    provider: Provider.OpenAI,
    model: 'gpt-4o',
    requestedModel: 'gpt-4o',
    response: {
      status: 200,
      headers: {},
      body: { choices: [{ message: { content: 'test' } }] },
    },
  };
}

describe('RequestQueue', () => {
  let queue: RequestQueue;

  beforeEach(() => {
    queue = new RequestQueue(10, 30000, 5000);
  });

  describe('enqueue (sync path)', () => {
    it('resolves inline when wait < asyncThreshold', async () => {
      const mockResult = makeMockResult();
      queue.setDrainFunction(async () => mockResult);

      const result = await queue.enqueue(Capability.Chat, 'gpt-4o', 100);
      expect(result.mode).toBe('sync');
      if (result.mode === 'sync') {
        expect(result.result).toEqual(mockResult);
      }
    });
  });

  describe('enqueue (async path)', () => {
    it('returns async job descriptor when wait > asyncThreshold', async () => {
      const mockResult = makeMockResult();
      queue.setDrainFunction(async () => mockResult);

      const result = await queue.enqueue(Capability.Chat, 'gpt-4o', 10000);
      expect(result.mode).toBe('async');
      if (result.mode === 'async') {
        expect(result.jobId).toBeTruthy();
        expect(result.estimatedWaitMs).toBe(10000);
      }
    });
  });

  describe('poll', () => {
    it('returns not_found for unknown jobId', () => {
      const result = queue.poll('unknown-id');
      expect(result.status).toBe('not_found');
    });

    it('returns pending for queued async job', async () => {
      // Return a never-resolving promise (simulates long wait)
      queue.setDrainFunction(() => new Promise(() => {}));

      const enqueued = await queue.enqueue(Capability.Chat, 'gpt-4o', 10000);
      if (enqueued.mode !== 'async') throw new Error('Expected async mode');

      const polled = queue.poll(enqueued.jobId);
      expect(polled.status).toBe('pending');
    });
  });

  describe('queue limits', () => {
    it('throws when queue is full', async () => {
      const smallQueue = new RequestQueue(2, 30000, 5000);
      // Fill with non-resolving jobs
      smallQueue.setDrainFunction(() => new Promise(() => {}));

      await smallQueue.enqueue(Capability.Chat, 'gpt-4o', 10000);
      await smallQueue.enqueue(Capability.Chat, 'gpt-4o', 10000);

      await expect(smallQueue.enqueue(Capability.Chat, 'gpt-4o', 10000)).rejects.toThrow(
        'queue is full'
      );
    });
  });

  describe('size', () => {
    it('tracks number of jobs', async () => {
      expect(queue.size).toBe(0);
      queue.setDrainFunction(() => new Promise(() => {}));
      await queue.enqueue(Capability.Chat, 'gpt-4o', 10000);
      expect(queue.size).toBe(1);
    });
  });
});
