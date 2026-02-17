import { type Provider } from '../types/provider.js';
import { CircuitBreaker, type ProviderCircuit } from './CircuitBreaker.js';
import { Redis } from './redis.js';

const PREFIX = 'ai-router:cb:';

/**
 * Circuit breaker backed by Redis for state persistence across restarts and instances.
 * Reads are always served from the in-memory map (fast path).
 * Writes fire-and-forget to Redis (background async).
 * If Redis is unavailable, falls back to in-memory-only gracefully.
 */
export class CircuitBreakerRedis extends CircuitBreaker {
  private readonly redis: Redis;
  private readonly ttlMs: number;

  constructor(failureThreshold: number, cooldownMs: number, redis: Redis) {
    super(failureThreshold, cooldownMs);
    this.redis = redis;
    this.ttlMs = cooldownMs * 3;
  }

  override isAvailable(provider: Provider): boolean {
    const result = super.isAvailable(provider);
    // super may have transitioned open→half-open; persist updated state
    void this.persist(provider);
    return result;
  }

  override recordSuccess(provider: Provider): void {
    super.recordSuccess(provider);
    void this.persist(provider);
  }

  override recordFailure(provider: Provider, statusCode: number): void {
    super.recordFailure(provider, statusCode);
    void this.persist(provider);
  }

  private async persist(provider: Provider): Promise<void> {
    const circuit = this.circuits.get(provider);
    if (!circuit) return;
    const key = `${PREFIX}${provider}`;
    try {
      await this.redis.set(key, JSON.stringify(circuit), 'PX', this.ttlMs);
    } catch {
      // Graceful degradation — Redis unavailable, in-memory state still works
    }
  }

  /**
   * On startup: load circuit states persisted from a previous run or another instance.
   */
  async loadFromRedis(): Promise<void> {
    try {
      const keys = await this.redis.keys(`${PREFIX}*`);
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const provider = key.slice(PREFIX.length) as Provider;
        try {
          const circuit = JSON.parse(raw) as ProviderCircuit;
          this.circuits.set(provider, circuit);
        } catch {
          // Ignore malformed data
        }
      }
    } catch {
      // Redis unavailable — start with clean in-memory state
    }
  }
}
