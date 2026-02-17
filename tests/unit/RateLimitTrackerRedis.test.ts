import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitTrackerRedis } from '../../src/core/RateLimitTrackerRedis.js';
import { Provider } from '../../src/types/provider.js';

// Mock ioredis
vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    keys: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
  }));
  return { default: MockRedis };
});

function createMockRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    keys: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
  };
}

describe('RateLimitTrackerRedis', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let tracker: RateLimitTrackerRedis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    tracker = new RateLimitTrackerRedis(5, mockRedis as never);
  });

  describe('update() with 429', () => {
    it('calls super.update and persists to Redis', async () => {
      tracker.update(Provider.OpenAI, 'gpt-4o', { 'retry-after': '30' }, 429);
      // Allow microtasks to run
      await Promise.resolve();
      expect(mockRedis.set).toHaveBeenCalledWith(
        'ai-router:rl:openai:gpt-4o',
        expect.any(String),
        'PX',
        expect.any(Number)
      );
    });

    it('persists coolingDown=true and a future cooldownUntil on 429', async () => {
      const before = Date.now();
      tracker.update(Provider.OpenAI, 'gpt-4o', { 'retry-after': '30' }, 429);
      await Promise.resolve();

      const lastCall = mockRedis.set.mock.calls[0];
      const state = JSON.parse(lastCall?.[1] as string);
      expect(state.coolingDown).toBe(true);
      expect(state.cooldownUntil).toBeGreaterThan(before + 29_000);
    });

    it('uses at least 60s TTL even for short cooldowns', async () => {
      tracker.update(Provider.OpenAI, 'gpt-4o', { 'retry-after': '1' }, 429);
      await Promise.resolve();

      const lastCall = mockRedis.set.mock.calls[0];
      const ttl = lastCall?.[3] as number;
      expect(ttl).toBeGreaterThanOrEqual(60_000);
    });
  });

  describe('update() with 200', () => {
    it('persists updated remaining counts from headers', async () => {
      tracker.update(
        Provider.OpenAI,
        'gpt-4o',
        {
          'x-ratelimit-remaining-requests': '42',
          'x-ratelimit-remaining-tokens': '10000',
        },
        200
      );
      await Promise.resolve();

      expect(mockRedis.set).toHaveBeenCalledWith(
        'ai-router:rl:openai:gpt-4o',
        expect.any(String),
        'PX',
        expect.any(Number)
      );

      const lastCall = mockRedis.set.mock.calls[0];
      const state = JSON.parse(lastCall?.[1] as string);
      expect(state.remainingRequests).toBe(42);
      expect(state.coolingDown).toBe(false);
    });

    it('persists Anthropic header format', async () => {
      tracker.update(
        Provider.Anthropic,
        'claude-opus-4-6',
        {
          'anthropic-ratelimit-requests-remaining': '99',
          'anthropic-ratelimit-tokens-remaining': '50000',
        },
        200
      );
      await Promise.resolve();

      const lastCall = mockRedis.set.mock.calls[0];
      const state = JSON.parse(lastCall?.[1] as string);
      expect(state.remainingRequests).toBe(99);
    });
  });

  describe('loadFromRedis()', () => {
    it('does nothing when Redis has no keys', async () => {
      mockRedis.keys.mockResolvedValue([]);
      await tracker.loadFromRedis();
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(false);
    });

    it('restores cooling down state from Redis', async () => {
      const stateData = {
        coolingDown: true,
        cooldownUntil: Date.now() + 30_000,
        remainingRequests: null,
        remainingTokens: null,
        resetRequestsAt: null,
        resetTokensAt: null,
      };
      mockRedis.keys.mockResolvedValue(['ai-router:rl:openai:gpt-4o']);
      mockRedis.get.mockResolvedValue(JSON.stringify(stateData));

      await tracker.loadFromRedis();
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(true);
    });

    it('restores low-remaining state from Redis', async () => {
      const stateData = {
        coolingDown: false,
        cooldownUntil: 0,
        remainingRequests: 2, // below threshold of 5
        remainingTokens: null,
        resetRequestsAt: null,
        resetTokensAt: null,
      };
      mockRedis.keys.mockResolvedValue(['ai-router:rl:anthropic:claude-opus-4-6']);
      mockRedis.get.mockResolvedValue(JSON.stringify(stateData));

      await tracker.loadFromRedis();
      expect(tracker.shouldAvoid(Provider.Anthropic, 'claude-opus-4-6')).toBe(true);
    });

    it('handles malformed keys gracefully (no colon separator)', async () => {
      mockRedis.keys.mockResolvedValue(['ai-router:rl:badkey']);
      mockRedis.get.mockResolvedValue('{}');
      await expect(tracker.loadFromRedis()).resolves.not.toThrow();
    });

    it('handles Redis errors gracefully', async () => {
      mockRedis.keys.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(tracker.loadFromRedis()).resolves.not.toThrow();
    });

    it('skips malformed JSON without throwing', async () => {
      mockRedis.keys.mockResolvedValue(['ai-router:rl:openai:gpt-4o']);
      mockRedis.get.mockResolvedValue('{{bad json}}');
      await expect(tracker.loadFromRedis()).resolves.not.toThrow();
    });
  });

  describe('graceful degradation', () => {
    it('continues working when Redis set fails', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis down'));
      // Should not throw
      tracker.update(Provider.Google, 'gemini-1.5-pro', { 'retry-after': '60' }, 429);
      await Promise.resolve();
      // In-memory state should still work
      expect(tracker.shouldAvoid(Provider.Google, 'gemini-1.5-pro')).toBe(true);
    });
  });
});
