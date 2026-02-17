/**
 * Utilities for parsing rate limit headers from various providers
 */

/**
 * Parse OpenAI duration strings like "6m0s", "30s", "1h30m0s" into milliseconds
 */
export function parseDuration(duration: string): number {
  let totalMs = 0;
  const hoursMatch = /(\d+)h/.exec(duration);
  const minutesMatch = /(\d+)m/.exec(duration);
  const secondsMatch = /(\d+(?:\.\d+)?)s/.exec(duration);

  if (hoursMatch?.[1]) totalMs += parseInt(hoursMatch[1], 10) * 3600 * 1000;
  if (minutesMatch?.[1]) totalMs += parseInt(minutesMatch[1], 10) * 60 * 1000;
  if (secondsMatch?.[1]) totalMs += parseFloat(secondsMatch[1]) * 1000;

  return totalMs;
}

/**
 * Parse a Retry-After header value into milliseconds from now.
 * Handles both integer seconds and HTTP-date formats.
 */
export function parseRetryAfter(value: string | undefined): number {
  if (!value) return 60_000; // default 60 seconds

  const seconds = parseInt(value, 10);
  if (!isNaN(seconds)) return seconds * 1000;

  // Try HTTP date format
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return 60_000;
}

export interface RateLimitHeaders {
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequestsAt: number | null; // epoch ms
  resetTokensAt: number | null; // epoch ms
}

/**
 * Extract rate limit state from OpenAI response headers.
 * OpenAI uses:
 *   x-ratelimit-remaining-requests
 *   x-ratelimit-remaining-tokens
 *   x-ratelimit-reset-requests   (e.g. "6m0s")
 *   x-ratelimit-reset-tokens     (e.g. "30s")
 */
export function extractOpenAIRateLimitHeaders(
  headers: Record<string, string>
): RateLimitHeaders {
  const remainingRequests = parseNullableInt(headers['x-ratelimit-remaining-requests']);
  const remainingTokens = parseNullableInt(headers['x-ratelimit-remaining-tokens']);

  const resetRequests = headers['x-ratelimit-reset-requests'];
  const resetTokens = headers['x-ratelimit-reset-tokens'];

  return {
    remainingRequests,
    remainingTokens,
    resetRequestsAt: resetRequests ? Date.now() + parseDuration(resetRequests) : null,
    resetTokensAt: resetTokens ? Date.now() + parseDuration(resetTokens) : null,
  };
}

/**
 * Extract rate limit state from Anthropic response headers.
 * Anthropic uses:
 *   anthropic-ratelimit-requests-remaining
 *   anthropic-ratelimit-tokens-remaining
 *   anthropic-ratelimit-requests-reset   (ISO 8601 date string)
 *   anthropic-ratelimit-tokens-reset     (ISO 8601 date string)
 */
export function extractAnthropicRateLimitHeaders(
  headers: Record<string, string>
): RateLimitHeaders {
  const remainingRequests = parseNullableInt(
    headers['anthropic-ratelimit-requests-remaining']
  );
  const remainingTokens = parseNullableInt(headers['anthropic-ratelimit-tokens-remaining']);

  const resetRequests = headers['anthropic-ratelimit-requests-reset'];
  const resetTokens = headers['anthropic-ratelimit-tokens-reset'];

  return {
    remainingRequests,
    remainingTokens,
    resetRequestsAt: resetRequests ? new Date(resetRequests).getTime() : null,
    resetTokensAt: resetTokens ? new Date(resetTokens).getTime() : null,
  };
}

/**
 * Google does not provide proactive rate limit headers — reactive only.
 */
export function extractGoogleRateLimitHeaders(
  _headers: Record<string, string>
): RateLimitHeaders {
  return {
    remainingRequests: null,
    remainingTokens: null,
    resetRequestsAt: null,
    resetTokensAt: null,
  };
}

function parseNullableInt(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

/**
 * Lowercase all header keys for consistent access
 */
export function normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}
