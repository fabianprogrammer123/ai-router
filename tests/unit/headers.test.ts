import { describe, it, expect } from 'vitest';
import {
  parseDuration,
  parseRetryAfter,
  extractOpenAIRateLimitHeaders,
  extractAnthropicRateLimitHeaders,
  normalizeHeaders,
} from '../../src/utils/headers.js';

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3600000);
  });

  it('parses combined duration', () => {
    expect(parseDuration('6m0s')).toBe(360000);
    expect(parseDuration('1h30m0s')).toBe(5400000);
    expect(parseDuration('1h2m3s')).toBe(3723000);
  });

  it('parses fractional seconds', () => {
    expect(parseDuration('0.5s')).toBe(500);
  });

  it('returns 0 for empty string', () => {
    expect(parseDuration('')).toBe(0);
  });
});

describe('parseRetryAfter', () => {
  it('returns default 60s for undefined', () => {
    expect(parseRetryAfter(undefined)).toBe(60000);
  });

  it('parses integer seconds', () => {
    expect(parseRetryAfter('30')).toBe(30000);
  });

  it('parses HTTP date format', () => {
    const future = new Date(Date.now() + 10000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).toBeGreaterThan(8000);
    expect(result).toBeLessThan(12000);
  });

  it('returns 60s for invalid value', () => {
    expect(parseRetryAfter('not-a-date')).toBe(60000);
  });
});

describe('extractOpenAIRateLimitHeaders', () => {
  it('extracts all rate limit fields', () => {
    const headers = {
      'x-ratelimit-remaining-requests': '100',
      'x-ratelimit-remaining-tokens': '50000',
      'x-ratelimit-reset-requests': '30s',
      'x-ratelimit-reset-tokens': '1s',
    };
    const result = extractOpenAIRateLimitHeaders(headers);
    expect(result.remainingRequests).toBe(100);
    expect(result.remainingTokens).toBe(50000);
    expect(result.resetRequestsAt).toBeGreaterThan(Date.now() + 29000);
    expect(result.resetTokensAt).toBeGreaterThan(Date.now() + 900);
  });

  it('returns nulls for missing headers', () => {
    const result = extractOpenAIRateLimitHeaders({});
    expect(result.remainingRequests).toBeNull();
    expect(result.remainingTokens).toBeNull();
    expect(result.resetRequestsAt).toBeNull();
    expect(result.resetTokensAt).toBeNull();
  });
});

describe('extractAnthropicRateLimitHeaders', () => {
  it('extracts all rate limit fields', () => {
    const resetTime = new Date(Date.now() + 30000).toISOString();
    const headers = {
      'anthropic-ratelimit-requests-remaining': '42',
      'anthropic-ratelimit-tokens-remaining': '12000',
      'anthropic-ratelimit-requests-reset': resetTime,
    };
    const result = extractAnthropicRateLimitHeaders(headers);
    expect(result.remainingRequests).toBe(42);
    expect(result.remainingTokens).toBe(12000);
    expect(result.resetRequestsAt).toBeGreaterThan(Date.now() + 29000);
  });
});

describe('normalizeHeaders', () => {
  it('lowercases all header keys', () => {
    const result = normalizeHeaders({ 'Content-Type': 'application/json', 'X-Custom': 'value' });
    expect(result['content-type']).toBe('application/json');
    expect(result['x-custom']).toBe('value');
  });

  it('joins array values with comma', () => {
    const result = normalizeHeaders({ 'Set-Cookie': ['a=1', 'b=2'] });
    expect(result['set-cookie']).toBe('a=1, b=2');
  });
});
