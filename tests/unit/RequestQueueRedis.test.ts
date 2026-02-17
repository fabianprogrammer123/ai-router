import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RequestQueueRedis } from '../../src/core/RequestQueueRedis.js';
import { Capability, Provider } from '../../src/types/provider.js';
import type { RouterResult } from '../../src/types/routing.js';

// Mock ioredis — return a plain constructor that vitest can track
vi.mock('ioredis', () => {
  const MockRedis = vi.fn();
  return { default: MockRedis, Redis: MockRedis };
});

function createMockRedis() {
  return {
    rpush: vi.fn().mockResolvedValue(1),
    lpop: vi.fn().mockResolvedValue(null),
    hset: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    exists: vi.fn().mockResolvedValue(0),
    del: vi.fn().mockResolvedValue(1),
    llen: vi.fn().mockResolvedValue(0),
    keys: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
  };
}

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

describe('RequestQueueRedis', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let queue: RequestQueueRedis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    // asyncThresholdMs = 5000 — waits ≤ 5000ms use sync (in-memory) path
    queue = new RequestQueueRedis(10, 30000, 5000, mockRedis as never);
  });

  describe('enqueue — sync path (estimatedWaitMs ≤ asyncThreshold)', () => {
    it('uses in-memory path and does not touch Redis', async () => {
      const mockResult = makeMockResult();
      queue.setDrainFunction(async () => mockResult);

      // estimatedWaitMs=0 → immediate drain (no timer delay)
      const result = await queue.enqueue(Capability.Chat, 'gpt-4o', 0);
      expect(result.mode).toBe('sync');
      expect(mockRedis.rpush).not.toHaveBeenCalled();
      expect(mockRedis.hset).not.toHaveBeenCalled();
    });
  });

  describe('enqueue — async path (estimatedWaitMs > asyncThreshold)', () => {
    it('pushes to Redis pending list and stores job data', async () => {
      queue.setDrainFunction(() => new Promise(() => {})); // never resolves

      const result = await queue.enqueue(Capability.Chat, 'gpt-4o', 10000);
      expect(result.mode).toBe('async');

      expect(mockRedis.rpush).toHaveBeenCalledWith(
        'ai-router:queue:pending',
        expect.any(String) // jobId
      );
      expect(mockRedis.hset).toHaveBeenCalledWith(
        expect.stringMatching(/^ai-router:queue:job:/),
        expect.objectContaining({
          capability: Capability.Chat,
          requestedModel: 'gpt-4o',
        })
      );
    });

    it('degrades to in-memory when Redis rpush fails', async () => {
      mockRedis.rpush.mockRejectedValue(new Error('Redis down'));
      queue.setDrainFunction(() => new Promise(() => {}));

      // Should fall back gracefully without throwing
      const result = await queue.enqueue(Capability.Chat, 'gpt-4o', 10000);
      expect(result.mode).toBe('async');
    });

    it('serializes body as JSON', async () => {
      queue.setDrainFunction(() => new Promise(() => {}));
      const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };

      await queue.enqueue(Capability.Chat, 'gpt-4o', 10000, body);

      const hsetCall = mockRedis.hset.mock.calls[0];
      const jobData = hsetCall?.[1] as Record<string, string>;
      expect(JSON.parse(jobData['body'] ?? '{}')).toEqual(body);
    });
  });

  describe('poll()', () => {
    it('returns not_found for unknown job not in Redis', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.exists.mockResolvedValue(0);

      const result = await queue.poll('unknown-job-id');
      expect(result.status).toBe('not_found');
    });

    it('returns pending when job data exists in Redis but no result yet', async () => {
      mockRedis.get.mockResolvedValue(null); // no result
      mockRedis.exists.mockResolvedValue(1); // job data exists

      const result = await queue.poll('some-job-id');
      expect(result.status).toBe('pending');
    });

    it('returns done with result when Redis result exists', async () => {
      const mockResult = makeMockResult();
      const redisResult = JSON.stringify({ status: 'done', result: mockResult });
      mockRedis.get.mockResolvedValue(redisResult);

      const result = await queue.poll('some-job-id');
      expect(result.status).toBe('done');
      expect(result.result).toEqual(mockResult);
    });

    it('returns error status from Redis', async () => {
      const redisResult = JSON.stringify({ status: 'error', error: 'Provider unavailable' });
      mockRedis.get.mockResolvedValue(redisResult);

      const result = await queue.poll('some-job-id');
      expect(result.status).toBe('error');
      expect(result.error).toBe('Provider unavailable');
    });

    it('returns not_found when Redis throws', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis down'));
      const result = await queue.poll('some-job-id');
      expect(result.status).toBe('not_found');
    });
  });

  describe('drain() — Redis async jobs', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('processes a job from the Redis pending list', async () => {
      const mockResult = makeMockResult();
      queue.setDrainFunction(async () => mockResult);

      const jobId = 'test-job-id';
      const jobData = {
        id: jobId,
        capability: Capability.Chat,
        requestedModel: 'gpt-4o',
        body: '',
        createdAt: String(Date.now()),
        timeoutAt: String(Date.now() + 30000),
        estimatedWaitMs: '10000',
      };

      mockRedis.lpop.mockResolvedValueOnce(jobId);
      mockRedis.hgetall.mockResolvedValueOnce(jobData);

      // Trigger drain via scheduleProcessing
      queue.scheduleProcessing(0);
      await vi.runAllTimersAsync();

      expect(mockRedis.lpop).toHaveBeenCalledWith('ai-router:queue:pending');
      expect(mockRedis.set).toHaveBeenCalledWith(
        `ai-router:queue:result:${jobId}`,
        expect.stringContaining('"status":"done"'),
        'EX',
        3600
      );
      expect(mockRedis.del).toHaveBeenCalledWith(`ai-router:queue:job:${jobId}`);
    });

    it('marks expired jobs and stores result in Redis', async () => {
      queue.setDrainFunction(async () => makeMockResult());

      const jobId = 'expired-job';
      const jobData = {
        id: jobId,
        capability: Capability.Chat,
        requestedModel: 'gpt-4o',
        body: '',
        createdAt: String(Date.now() - 60000),
        timeoutAt: String(Date.now() - 1), // already expired
        estimatedWaitMs: '10000',
      };

      mockRedis.lpop.mockResolvedValueOnce(jobId);
      mockRedis.hgetall.mockResolvedValueOnce(jobData);

      queue.scheduleProcessing(0);
      await vi.runAllTimersAsync();

      expect(mockRedis.set).toHaveBeenCalledWith(
        `ai-router:queue:result:${jobId}`,
        expect.stringContaining('"status":"expired"'),
        'EX',
        3600
      );
    });
  });

  describe('loadPendingFromRedis()', () => {
    it('schedules drain when pending jobs exist in Redis', async () => {
      mockRedis.llen.mockResolvedValue(3);
      const scheduleSpy = vi.spyOn(queue, 'scheduleProcessing');

      await queue.loadPendingFromRedis();
      expect(scheduleSpy).toHaveBeenCalledWith(0);
    });

    it('does not schedule drain when pending list is empty', async () => {
      mockRedis.llen.mockResolvedValue(0);
      const scheduleSpy = vi.spyOn(queue, 'scheduleProcessing');

      await queue.loadPendingFromRedis();
      expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it('handles Redis errors gracefully', async () => {
      mockRedis.llen.mockRejectedValue(new Error('Redis down'));
      await expect(queue.loadPendingFromRedis()).resolves.not.toThrow();
    });
  });

  describe('size getter', () => {
    it('returns 0 when no local jobs', () => {
      expect(queue.size).toBe(0);
    });

    it('counts sync jobs in local map', () => {
      queue.setDrainFunction(() => new Promise(() => {})); // never resolves
      // Kick off a sync enqueue without awaiting it (leaves job in this.jobs)
      void queue.enqueue(Capability.Chat, 'gpt-4o', 0);
      // At this point the job is stored but drain hasn't run yet
      // (drain is scheduled via setTimeout which hasn't fired)
      expect(queue.size).toBe(1);
    });
  });
});
