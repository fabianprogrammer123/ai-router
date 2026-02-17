import { z } from 'zod';

const commaSeparatedList = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim().toLowerCase()));

const envSchema = z.object({
  // Required
  ROUTER_API_KEY: z.string().min(1, 'ROUTER_API_KEY is required'),

  // Provider keys — at least one must be set; validated separately below
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Routing
  PROVIDER_PRIORITY: commaSeparatedList.default('openai,anthropic,google'),
  DEFAULT_ROUTING_STRATEGY: z.enum(['fallback', 'round-robin', 'latency']).default('fallback'),

  // Request Queue
  QUEUE_MAX_SIZE: z.coerce.number().int().positive().default(100),
  QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  QUEUE_ASYNC_THRESHOLD_MS: z.coerce.number().int().positive().default(5000),

  // Circuit Breaker
  CB_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CB_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),

  // Rate Limit Proactive Avoidance
  RATE_LIMIT_LOW_REQUESTS_THRESHOLD: z.coerce.number().int().nonnegative().default(5),
});

function loadConfig(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n[ai-router] Configuration error:\n${errors}\n`);
    process.exit(1);
  }

  const cfg = result.data;

  // Validate at least one provider key exists
  if (!cfg.OPENAI_API_KEY && !cfg.ANTHROPIC_API_KEY && !cfg.GOOGLE_API_KEY) {
    // eslint-disable-next-line no-console
    console.error(
      '\n[ai-router] At least one provider API key is required:\n' +
        '  OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY\n'
    );
    process.exit(1);
  }

  return cfg;
}

export const config = loadConfig();
export type Config = typeof config;
