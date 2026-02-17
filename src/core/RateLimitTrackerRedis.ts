import { type Provider } from '../types/provider.js';
import { RateLimitTracker, type ProviderModelState } from './RateLimitTracker.js';
import { Redis } from './redis.js';

const PREFIX = 'ai-router:rl:';

/**
 * Rate limit tracker backed by Redis for persistence across restarts and instances.
 * Reads are always served from the in-memory map (fast path).
 * Writes fire-and-forget to Redis after every significant state change.
 * If Redis is unavailable, falls back to in-memory-only gracefully.
 */
export class RateLimitTrackerRedis extends RateLimitTracker {
  private readonly redis: Redis;

  constructor(lowThreshold: number, redis: Redis) {
    super(lowThreshold);
    this.redis = redis;
  }

  override update(
    provider: Provider,
    model: string,
    headers: Record<string, string>,
    statusCode: number
  ): void {
    super.update(provider, model, headers, statusCode);
    void this.persist(provider, model);
  }

  private async persist(provider: Provider, model: string): Promise<void> {
    const key = `${PREFIX}${provider}:${model}`;
    const s = this.state.get(`${provider}:${model}`);
    if (!s) return;

    // TTL: at least 60s, or until the cooldown expires
    const ttlMs = Math.max(
      s.cooldownUntil > 0 ? s.cooldownUntil - Date.now() : 0,
      60_000
    );

    try {
      await this.redis.set(key, JSON.stringify(s), 'PX', ttlMs);
    } catch {
      // Graceful degradation — Redis unavailable, in-memory state still works
    }
  }

  /**
   * On startup: load rate limit states persisted from a previous run or another instance.
   */
  async loadFromRedis(): Promise<void> {
    try {
      const keys = await this.redis.keys(`${PREFIX}*`);
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;

        // Key format: "ai-router:rl:{provider}:{model}"
        const suffix = key.slice(PREFIX.length); // "{provider}:{model}"
        const colonIdx = suffix.indexOf(':');
        if (colonIdx === -1) continue;

        const internalKey = suffix; // same as makeKey(provider, model)
        try {
          const s = JSON.parse(raw) as ProviderModelState;
          this.state.set(internalKey, s);
        } catch {
          // Ignore malformed data
        }
      }
    } catch {
      // Redis unavailable — start with clean in-memory state
    }
  }
}
