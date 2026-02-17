import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitTracker } from '../../src/core/RateLimitTracker.js';
import { Provider } from '../../src/types/provider.js';

describe('RateLimitTracker', () => {
  let tracker: RateLimitTracker;

  beforeEach(() => {
    tracker = new RateLimitTracker(5); // low threshold = 5
  });

  describe('shouldAvoid', () => {
    it('returns false for unknown provider/model', () => {
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(false);
    });

    it('returns true after a 429 response', () => {
      tracker.update(Provider.OpenAI, 'gpt-4o', { 'retry-after': '30' }, 429);
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(true);
    });

    it('returns false after cooldown expires', () => {
      vi.useFakeTimers();
      tracker.update(Provider.OpenAI, 'gpt-4o', { 'retry-after': '1' }, 429);
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(true);

      vi.advanceTimersByTime(2000);
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(false);
      vi.useRealTimers();
    });

    it('returns true when remaining requests below threshold', () => {
      tracker.update(
        Provider.OpenAI,
        'gpt-4o',
        {
          'x-ratelimit-remaining-requests': '3',
          'x-ratelimit-remaining-tokens': '50000',
          'x-ratelimit-reset-requests': '30s',
          'x-ratelimit-reset-tokens': '1s',
        },
        200
      );
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(true);
    });

    it('returns false when remaining requests above threshold', () => {
      tracker.update(
        Provider.OpenAI,
        'gpt-4o',
        {
          'x-ratelimit-remaining-requests': '100',
          'x-ratelimit-remaining-tokens': '50000',
          'x-ratelimit-reset-requests': '30s',
          'x-ratelimit-reset-tokens': '1s',
        },
        200
      );
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(false);
    });

    it('clears cooldown state on 200 after cooldown expires', () => {
      vi.useFakeTimers();
      tracker.update(Provider.OpenAI, 'gpt-4o', { 'retry-after': '1' }, 429);
      vi.advanceTimersByTime(2000);

      tracker.update(
        Provider.OpenAI,
        'gpt-4o',
        { 'x-ratelimit-remaining-requests': '100' },
        200
      );
      expect(tracker.shouldAvoid(Provider.OpenAI, 'gpt-4o')).toBe(false);
      vi.useRealTimers();
    });
  });

  describe('update', () => {
    it('parses OpenAI rate limit headers correctly', () => {
      tracker.update(
        Provider.OpenAI,
        'gpt-4o',
        {
          'x-ratelimit-remaining-requests': '50',
          'x-ratelimit-remaining-tokens': '25000',
          'x-ratelimit-reset-requests': '1m30s',
        },
        200
      );
      const state = tracker.getState(Provider.OpenAI, 'gpt-4o');
      expect(state?.remainingRequests).toBe(50);
      expect(state?.remainingTokens).toBe(25000);
      expect(state?.resetRequestsAt).toBeGreaterThan(Date.now() + 89000);
    });

    it('parses Anthropic rate limit headers correctly', () => {
      const resetTime = new Date(Date.now() + 30000).toISOString();
      tracker.update(
        Provider.Anthropic,
        'claude-opus-4-6',
        {
          'anthropic-ratelimit-requests-remaining': '42',
          'anthropic-ratelimit-tokens-remaining': '12000',
          'anthropic-ratelimit-requests-reset': resetTime,
        },
        200
      );
      const state = tracker.getState(Provider.Anthropic, 'claude-opus-4-6');
      expect(state?.remainingRequests).toBe(42);
      expect(state?.remainingTokens).toBe(12000);
    });

    it('sets default 60s cooldown when Retry-After is missing on 429', () => {
      tracker.update(Provider.Google, 'gemini-1.5-pro', {}, 429);
      const state = tracker.getState(Provider.Google, 'gemini-1.5-pro');
      expect(state?.coolingDown).toBe(true);
      expect(state?.cooldownUntil).toBeGreaterThan(Date.now() + 59000);
    });
  });

  describe('earliestAvailableMs', () => {
    it('returns current time for unknown candidates (immediately available)', () => {
      const candidates = [{ provider: Provider.OpenAI, model: 'gpt-4o' }];
      const result = tracker.earliestAvailableMs(candidates);
      expect(result).toBeLessThanOrEqual(Date.now() + 100);
    });

    it('returns cooldown time for cooling providers', () => {
      tracker.update(Provider.OpenAI, 'gpt-4o', { 'retry-after': '30' }, 429);
      const candidates = [{ provider: Provider.OpenAI, model: 'gpt-4o' }];
      const result = tracker.earliestAvailableMs(candidates);
      expect(result).toBeGreaterThan(Date.now() + 25000);
      expect(result).toBeLessThan(Date.now() + 35000);
    });
  });
});
