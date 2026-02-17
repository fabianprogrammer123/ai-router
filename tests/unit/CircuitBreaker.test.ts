import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from '../../src/core/CircuitBreaker.js';
import { Provider } from '../../src/types/provider.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker(3, 60000); // 3 failures to open, 60s cooldown
  });

  describe('isAvailable', () => {
    it('starts in closed state (available)', () => {
      expect(cb.isAvailable(Provider.OpenAI)).toBe(true);
      expect(cb.getState(Provider.OpenAI)).toBe('closed');
    });

    it('remains closed after fewer failures than threshold', () => {
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      expect(cb.isAvailable(Provider.OpenAI)).toBe(true);
      expect(cb.getState(Provider.OpenAI)).toBe('closed');
    });

    it('opens after threshold 5xx failures', () => {
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 502);
      cb.recordFailure(Provider.OpenAI, 503);
      expect(cb.isAvailable(Provider.OpenAI)).toBe(false);
      expect(cb.getState(Provider.OpenAI)).toBe('open');
    });

    it('does NOT open on 429 (rate limit) errors', () => {
      cb.recordFailure(Provider.OpenAI, 429);
      cb.recordFailure(Provider.OpenAI, 429);
      cb.recordFailure(Provider.OpenAI, 429);
      cb.recordFailure(Provider.OpenAI, 429);
      cb.recordFailure(Provider.OpenAI, 429);
      expect(cb.isAvailable(Provider.OpenAI)).toBe(true);
      expect(cb.getState(Provider.OpenAI)).toBe('closed');
    });

    it('does NOT open on 4xx client errors (except 429)', () => {
      cb.recordFailure(Provider.OpenAI, 400);
      cb.recordFailure(Provider.OpenAI, 401);
      cb.recordFailure(Provider.OpenAI, 403);
      expect(cb.isAvailable(Provider.OpenAI)).toBe(true);
    });

    it('transitions to half-open after cooldown expires', () => {
      vi.useFakeTimers();

      // Open the circuit
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      expect(cb.getState(Provider.OpenAI)).toBe('open');
      expect(cb.isAvailable(Provider.OpenAI)).toBe(false);

      // Advance past cooldown
      vi.advanceTimersByTime(61000);
      expect(cb.isAvailable(Provider.OpenAI)).toBe(true);
      expect(cb.getState(Provider.OpenAI)).toBe('half-open');

      vi.useRealTimers();
    });

    it('only allows one test request in half-open state', () => {
      vi.useFakeTimers();

      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      vi.advanceTimersByTime(61000);

      // First call gets through
      expect(cb.isAvailable(Provider.OpenAI)).toBe(true);
      // Second call is blocked (test in-flight)
      expect(cb.isAvailable(Provider.OpenAI)).toBe(false);

      vi.useRealTimers();
    });

    it('closes after successful half-open test', () => {
      vi.useFakeTimers();

      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      vi.advanceTimersByTime(61000);

      cb.isAvailable(Provider.OpenAI); // half-open
      cb.recordSuccess(Provider.OpenAI);

      expect(cb.getState(Provider.OpenAI)).toBe('closed');
      expect(cb.isAvailable(Provider.OpenAI)).toBe(true);

      vi.useRealTimers();
    });

    it('reopens after failed half-open test', () => {
      vi.useFakeTimers();

      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      vi.advanceTimersByTime(61000);

      cb.isAvailable(Provider.OpenAI); // half-open
      cb.recordFailure(Provider.OpenAI, 500);

      expect(cb.getState(Provider.OpenAI)).toBe('open');
      expect(cb.isAvailable(Provider.OpenAI)).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('recordSuccess', () => {
    it('resets failure count', () => {
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordSuccess(Provider.OpenAI);
      // Now need 3 more failures to open
      cb.recordFailure(Provider.OpenAI, 500);
      cb.recordFailure(Provider.OpenAI, 500);
      expect(cb.getState(Provider.OpenAI)).toBe('closed');
    });
  });
});
