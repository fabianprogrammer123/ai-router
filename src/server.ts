import Fastify from 'fastify';
import { config } from './config.js';
import { Router } from './core/Router.js';
import { CircuitBreaker } from './core/CircuitBreaker.js';
import { CircuitBreakerRedis } from './core/CircuitBreakerRedis.js';
import { RateLimitTracker } from './core/RateLimitTracker.js';
import { RateLimitTrackerRedis } from './core/RateLimitTrackerRedis.js';
import { RequestQueue } from './core/RequestQueue.js';
import { RequestQueueRedis } from './core/RequestQueueRedis.js';
import { createRedisClient } from './core/redis.js';
import { OpenAIAdapter } from './providers/openai.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { GoogleAdapter } from './providers/google.js';
import { type ProviderAdapter } from './providers/base.js';
import { Provider } from './types/provider.js';
import { healthRoutes } from './routes/health.js';
import { createChatRoutes } from './routes/chat.js';
import { createImageRoutes } from './routes/images.js';
import { createEmbeddingRoutes } from './routes/embeddings.js';
import { createStatusRoutes } from './routes/status.js';
import { createQueueRoutes } from './routes/queue.js';
import { createMessagesRoutes } from './routes/messages.js';

export async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const fastify = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
      ],
    },
    disableRequestLogging: false,
    trustProxy: true,
  });

  // ── Redis (optional) ────────────────────────────────────────────────────

  const redis = config.REDIS_URL ? createRedisClient(config.REDIS_URL) : null;

  if (redis) {
    redis.on('error', (err: Error) => {
      fastify.log.warn({ err: err.message }, 'ai-router: Redis connection error — running in-memory fallback');
    });
  }

  // ── Dependency injection ────────────────────────────────────────────────

  const circuitBreaker = redis
    ? new CircuitBreakerRedis(config.CB_FAILURE_THRESHOLD, config.CB_COOLDOWN_MS, redis)
    : new CircuitBreaker(config.CB_FAILURE_THRESHOLD, config.CB_COOLDOWN_MS);

  const rateLimitTracker = redis
    ? new RateLimitTrackerRedis(config.RATE_LIMIT_LOW_REQUESTS_THRESHOLD, redis)
    : new RateLimitTracker(config.RATE_LIMIT_LOW_REQUESTS_THRESHOLD);

  const queue = redis
    ? new RequestQueueRedis(config.QUEUE_MAX_SIZE, config.QUEUE_TIMEOUT_MS, config.QUEUE_ASYNC_THRESHOLD_MS, redis)
    : new RequestQueue(config.QUEUE_MAX_SIZE, config.QUEUE_TIMEOUT_MS, config.QUEUE_ASYNC_THRESHOLD_MS);

  // Build provider adapters based on available API keys
  const adapters = new Map<Provider, ProviderAdapter>();
  if (config.OPENAI_API_KEY) {
    adapters.set(Provider.OpenAI, new OpenAIAdapter(config.OPENAI_API_KEY));
  }
  if (config.ANTHROPIC_API_KEY) {
    adapters.set(Provider.Anthropic, new AnthropicAdapter(config.ANTHROPIC_API_KEY));
  }
  if (config.GOOGLE_API_KEY) {
    adapters.set(Provider.Google, new GoogleAdapter(config.GOOGLE_API_KEY));
  }

  const router = new Router({
    providerPriority: config.PROVIDER_PRIORITY as Provider[],
    defaultStrategy: config.DEFAULT_ROUTING_STRATEGY,
    circuitBreaker,
    rateLimitTracker,
    queue,
    adapters,
    logger: fastify.log,
  });

  // ── Load persisted state from Redis (if available) ──────────────────────

  if (redis) {
    await Promise.all([
      circuitBreaker instanceof CircuitBreakerRedis
        ? circuitBreaker.loadFromRedis()
        : Promise.resolve(),
      rateLimitTracker instanceof RateLimitTrackerRedis
        ? rateLimitTracker.loadFromRedis()
        : Promise.resolve(),
      queue instanceof RequestQueueRedis
        ? queue.loadPendingFromRedis()
        : Promise.resolve(),
    ]).catch((err: Error) => {
      fastify.log.warn({ err: err.message }, 'ai-router: Failed to load state from Redis — starting fresh');
    });

    fastify.log.info('ai-router: Redis connected — persistent state enabled');
  }

  // ── Routes ──────────────────────────────────────────────────────────────

  await fastify.register(healthRoutes);
  await fastify.register(createChatRoutes(router, config.ROUTER_API_KEY));
  await fastify.register(createImageRoutes(router, config.ROUTER_API_KEY));
  await fastify.register(createEmbeddingRoutes(router, config.ROUTER_API_KEY));
  await fastify.register(createStatusRoutes(router));
  await fastify.register(createQueueRoutes(queue));
  await fastify.register(createMessagesRoutes(router, config.ROUTER_API_KEY));

  // ── Error handler ───────────────────────────────────────────────────────

  fastify.setErrorHandler(async (error, _request, reply) => {
    fastify.log.error({ err: error }, 'Unhandled error');
    return reply.status(error.statusCode ?? 500).send({
      error: {
        message: error.message,
        type: 'api_error',
        code: 'internal_server_error',
      },
    });
  });

  return fastify;
}

// ── Entrypoint ──────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`AI Router listening on ${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
