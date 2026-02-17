import { type Provider } from '../types/provider.js';
import {
  extractOpenAIRateLimitHeaders,
  extractAnthropicRateLimitHeaders,
  extractGoogleRateLimitHeaders,
  parseRetryAfter,
  type RateLimitHeaders,
} from '../utils/headers.js';

export interface ProviderModelState {
  coolingDown: boolean;
  cooldownUntil: number; // epoch ms; 0 = not cooling
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequestsAt: number | null;
  resetTokensAt: number | null;
}

function makeKey(provider: Provider, model: string): string {
  return `${provider}:${model}`;
}

export class RateLimitTracker {
  protected readonly state = new Map<string, ProviderModelState>();
  protected readonly lowThreshold: number;

  constructor(lowRequestsThreshold: number) {
    this.lowThreshold = lowRequestsThreshold;
  }

  private getOrCreate(provider: Provider, model: string): ProviderModelState {
    const key = makeKey(provider, model);
    let s = this.state.get(key);
    if (!s) {
      s = {
        coolingDown: false,
        cooldownUntil: 0,
        remainingRequests: null,
        remainingTokens: null,
        resetRequestsAt: null,
        resetTokensAt: null,
      };
      this.state.set(key, s);
    }
    return s;
  }

  /**
   * Update state after a provider response (success or 429)
   */
  update(
    provider: Provider,
    model: string,
    headers: Record<string, string>,
    statusCode: number
  ): void {
    const s = this.getOrCreate(provider, model);

    if (statusCode === 429) {
      s.coolingDown = true;
      const retryAfterMs = parseRetryAfter(headers['retry-after']);
      s.cooldownUntil = Date.now() + retryAfterMs;
      return;
    }

    // On success (2xx), parse provider-specific headers and clear cooldown
    const parsed = this.parseHeaders(provider, headers);
    s.remainingRequests = parsed.remainingRequests;
    s.remainingTokens = parsed.remainingTokens;
    s.resetRequestsAt = parsed.resetRequestsAt;
    s.resetTokensAt = parsed.resetTokensAt;

    // Clear cooldown if we're past it
    if (s.coolingDown && Date.now() >= s.cooldownUntil) {
      s.coolingDown = false;
      s.cooldownUntil = 0;
    }
  }

  private parseHeaders(provider: Provider, headers: Record<string, string>): RateLimitHeaders {
    switch (provider) {
      case 'openai':
        return extractOpenAIRateLimitHeaders(headers);
      case 'anthropic':
        return extractAnthropicRateLimitHeaders(headers);
      case 'google':
        return extractGoogleRateLimitHeaders(headers);
      default:
        return {
          remainingRequests: null,
          remainingTokens: null,
          resetRequestsAt: null,
          resetTokensAt: null,
        };
    }
  }

  /**
   * Returns true if we should skip this provider+model to avoid a rate limit.
   * Reasons:
   *  1. Actively cooling down from a 429
   *  2. Remaining requests/tokens below the low threshold
   */
  shouldAvoid(provider: Provider, model: string): boolean {
    const key = makeKey(provider, model);
    const s = this.state.get(key);
    if (!s) return false;

    // Check if cooldown has expired
    if (s.coolingDown) {
      if (Date.now() < s.cooldownUntil) return true;
      // Expired — clear it
      s.coolingDown = false;
      s.cooldownUntil = 0;
    }

    // Proactive: avoid if remaining is known and very low
    if (s.remainingRequests !== null && s.remainingRequests < this.lowThreshold) {
      return true;
    }

    return false;
  }

  /**
   * Returns the earliest epoch ms at which any of the candidates will become
   * available again. Used by the queue to schedule the drain.
   */
  earliestAvailableMs(candidates: Array<{ provider: Provider; model: string }>): number {
    let earliest = Date.now() + 60_000; // default: 60 seconds from now

    for (const { provider, model } of candidates) {
      const s = this.state.get(makeKey(provider, model));
      if (!s) {
        // Unknown state — could be available right now
        return Date.now();
      }

      if (s.coolingDown && s.cooldownUntil > 0) {
        earliest = Math.min(earliest, s.cooldownUntil);
        continue;
      }

      // If remaining requests is known and low, use reset time
      if (s.remainingRequests !== null && s.remainingRequests < this.lowThreshold) {
        if (s.resetRequestsAt !== null) {
          earliest = Math.min(earliest, s.resetRequestsAt);
        }
      } else {
        // This provider/model is available
        return Date.now();
      }
    }

    return earliest;
  }

  /**
   * Get a snapshot of the state for a specific provider+model (for status endpoint)
   */
  getState(provider: Provider, model: string): ProviderModelState | undefined {
    return this.state.get(makeKey(provider, model));
  }

  /**
   * Get all known states (for status endpoint)
   */
  getAllStates(): Map<string, ProviderModelState> {
    return this.state;
  }
}
