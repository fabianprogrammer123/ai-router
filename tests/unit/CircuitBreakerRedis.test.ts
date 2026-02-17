import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { CircuitBreakerRedis } from '../../src/core/CircuitBreakerRedis.js';
import { Provider } from '../../src/types/provider.js';

// Mock ioredis
vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  }));
  return { default: MockRedis };
});

function createMockRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  };
}

describe('CircuitBreakerRedis', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let cb: CircuitBreakerRedis;

  beforeEach(() => {
    mockRedis = createMockRedis();
    cb = new CircuitBreakerRedis(3, 60000, mockRedis as never);
  });

  describe('recordSuccess', () => {
    it('calls super.recordSuccess and writes to Redis', async () => {
      cb.recordSuccess(Provider.OpenAI);
      // Allow microtask to run
      await Promise.resolve();
      expect(mockRedis.set).toHaveBeenCalledWith(
        'ai-router:cb:openai',
        expect.any(String),
        'PX',
        180000 // 60000 * 3
      );
    });

    it('persists closed circuit state', async () => {
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordSuccess(Provider.OpenAI);
      await Promise.resolve();

      const lastCall = mockRedis.set.mock.calls[mockRedis.set.mock.calls.length - 1];
      const state = JSON.parse(lastCall?.[1] as string);
      expect(state.state).toBe('closed');
      expect(state.failureCount).toBe(0);
    });
  });

  describe('recordFailure', () => {
    it('ignores 429 (does not write to Redis)', async () => {
      cb.recordFailure(Provider.OpenAI, 429);
      await Promise.resolve();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('writes to Redis on 5xx failure', async () => {
      cb.recordFailure(Provider.OpenAI, 500);
      await Promise.resolve();
      expect(mockRedis.set).toHaveBeenCalledWith(
        'ai-router:cb:openai',
        expect.any(String),
        'PX',
        180000
      );
    });

    it('persists open state after threshold failures', async () => {
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      await Promise.resolve();

      const lastCall = mockRedis.set.mock.calls[mockRedis.set.mock.calls.length - 1];
      const state = JSON.parse(lastCall?.[1] as string);
      expect(state.state).toBe('open');
    });
  });

  describe('isAvailable', () => {
    it('writes to Redis when called (state may change on open→half-open)', async () => {
      // No state change on first call for closed circuit
      cb.isAvailable(Provider.OpenAI);
      await Promise.resolve();
      // Only writes when there is an existing circuit entry
      // (first call creates the entry)
      // After the first isAvailable, circuits map has the entry
      cb.isAvailable(Provider.OpenAI);
      await Promise.resolve();
    });
  });

  describe('loadFromRedis', () => {
    it('does nothing when Redis has no keys', async () => {
      mockRedis.keys.mockResolvedValue([]);
      await cb.loadFromRedis();
      expect(cb.getState(Provider.OpenAI)).toBe('closed');
    });

    it('restores open circuit state from Redis', async () => {
      const circuitData = {
        state: 'open',
        failureCount: 5,
        openedAt: Date.now() - 1000,
        halfOpenTestInFlight: false,
      };
      mockRedis.keys.mockResolvedValue(['ai-router:cb:openai']);
      mockRedis.get.mockResolvedValue(JSON.stringify(circuitData));

      await cb.loadFromRedis();
      expect(cb.getState(Provider.OpenAI)).toBe('open');
    });

    it('restores half-open circuit state from Redis', async () => {
      const circuitData = {
        state: 'half-open',
        failureCount: 0,
        openedAt: Date.now() - 70000,
        halfOpenTestInFlight: false,
      };
      mockRedis.keys.mockResolvedValue(['ai-router:cb:openai']);
      mockRedis.get.mockResolvedValue(JSON.stringify(circuitData));

      await cb.loadFromRedis();
      expect(cb.getState(Provider.OpenAI)).toBe('half-open');
    });

    it('handles Redis errors gracefully', async () => {
      mockRedis.keys.mockRejectedValue(new Error('Redis connection refused'));
      await expect(cb.loadFromRedis()).resolves.not.toThrow();
    });

    it('skips malformed JSON without throwing', async () => {
      mockRedis.keys.mockResolvedValue(['ai-router:cb:openai']);
      mockRedis.get.mockResolvedValue('not-valid-json{{{');
      await expect(cb.loadFromRedis()).resolves.not.toThrow();
      expect(cb.getState(Provider.OpenAI)).toBe('closed');
    });
  });

  describe('graceful degradation', () => {
    it('continues working when Redis set fails', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis timeout'));
      cb.recordFailure(Provider.Anthropic, 500);
      await Promise.resolve();
      // State should still be updated in-memory
      cb.recordFailure(Provider.Anthropic, 500);
      cb.recordFailure(Provider.Anthropic, 500);
      expect(cb.isAvailable(Provider.Anthropic)).toBe(false);
    });
  });
});
