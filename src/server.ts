import Fastify from 'fastify';
import { config } from './config.js';
import { Router } from './core/Router.js';
import { CircuitBreaker } from './core/CircuitBreaker.js';
import { RateLimitTracker } from './core/RateLimitTracker.js';
import { RequestQueue } from './core/RequestQueue.js';
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

  // ── Dependency injection ────────────────────────────────────────────────

  const circuitBreaker = new CircuitBreaker(
    config.CB_FAILURE_THRESHOLD,
    config.CB_COOLDOWN_MS
  );

  const rateLimitTracker = new RateLimitTracker(config.RATE_LIMIT_LOW_REQUESTS_THRESHOLD);

  const queue = new RequestQueue(
    config.QUEUE_MAX_SIZE,
    config.QUEUE_TIMEOUT_MS,
    config.QUEUE_ASYNC_THRESHOLD_MS
  );

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
  });

  // ── Routes ──────────────────────────────────────────────────────────────

  await fastify.register(healthRoutes);
  await fastify.register(createChatRoutes(router, config.ROUTER_API_KEY));
  await fastify.register(createImageRoutes(router, config.ROUTER_API_KEY));
  await fastify.register(createEmbeddingRoutes(router, config.ROUTER_API_KEY));
  await fastify.register(createStatusRoutes(router));
  await fastify.register(createQueueRoutes(queue));

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
