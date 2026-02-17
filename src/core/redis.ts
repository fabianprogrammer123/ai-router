import { Redis } from 'ioredis';

export { Redis };

export const REDIS_PREFIX = 'ai-router:';

/**
 * Create a lazily-connected ioredis client.
 * Falls back gracefully if Redis is unavailable — callers must handle rejected promises.
 */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    retryStrategy: (times: number) => {
      if (times > 3) return null; // stop retrying
      return Math.min(times * 200, 1000);
    },
  });
}
