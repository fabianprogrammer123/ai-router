import { type Provider, type Capability } from '../types/provider.js';
import { Provider as ProviderEnum, getModelForProvider, getCapabilityForModel, MODEL_MAPPINGS, findModelMapping } from '../types/provider.js';
import { type FallbackChainEntry } from '../types/routing.js';
import { ProviderError } from '../types/request.js';
import { type RouterResult, type RouterExecuteResult } from '../types/routing.js';
import { type RoutingStrategy } from '../types/routing.js';
import { type ProviderAdapter } from '../providers/base.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { RateLimitTracker } from './RateLimitTracker.js';
import { RequestQueue } from './RequestQueue.js';
import { normalizeHeaders } from '../utils/headers.js';

export interface RouterLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface RouterConfig {
  providerPriority: Provider[];
  defaultStrategy: RoutingStrategy;
  circuitBreaker: CircuitBreaker;
  rateLimitTracker: RateLimitTracker;
  queue: RequestQueue;
  adapters: Map<Provider, ProviderAdapter>;
  logger?: RouterLogger;
}

export class Router {
  private readonly config: RouterConfig;

  constructor(config: RouterConfig) {
    this.config = config;

    // Wire up the queue drain function to call back into the router
    this.config.queue.setDrainFunction(async (_jobId, capability, requestedModel, signal, body) => {
      return this.executeProviderChain(requestedModel, capability, signal, 'fallback', body);
    });
  }

  async execute(
    requestedModel: string,
    capability: Capability,
    signal: AbortSignal,
    strategy?: RoutingStrategy,
    body?: unknown
  ): Promise<RouterExecuteResult> {
    const effectiveStrategy = strategy ?? this.config.defaultStrategy;

    try {
      return await this.executeProviderChain(requestedModel, capability, signal, effectiveStrategy, body);
    } catch (err) {
      if (err instanceof AllProvidersExhaustedError) {
        // Queue the request
        const candidates = this.buildFallbackChain(requestedModel, capability, effectiveStrategy);
        const estimatedWaitMs = this.config.rateLimitTracker.earliestAvailableMs(candidates) - Date.now();

        const queued = await this.config.queue.enqueue(
          capability,
          requestedModel,
          Math.max(0, estimatedWaitMs),
          body
        );

        if (queued.mode === 'sync') {
          return queued.result;
        }
        return { mode: 'async', jobId: queued.jobId, estimatedWaitMs: queued.estimatedWaitMs };
      }
      throw err;
    }
  }

  async executeProviderChain(
    requestedModel: string,
    capability: Capability,
    signal: AbortSignal,
    strategy: RoutingStrategy,
    body?: unknown
  ): Promise<RouterResult> {
    const chain = this.buildFallbackChain(requestedModel, capability, strategy);
    const firstProvider = chain[0]?.provider;

    for (const { provider, model } of chain) {
      if (!this.config.circuitBreaker.isAvailable(provider)) continue;
      if (this.config.rateLimitTracker.shouldAvoid(provider, model)) continue;

      const adapter = this.config.adapters.get(provider);
      if (!adapter) continue;

      try {
        const response = await adapter.call(capability, requestedModel, model, signal, body);

        const headers = normalizeHeaders(
          response.headers as Record<string, string | string[]>
        );
        this.config.rateLimitTracker.update(provider, model, headers, response.status);
        this.config.circuitBreaker.recordSuccess(provider);

        if (this.config.logger && provider !== firstProvider) {
          const usedTier = findModelMapping(model)?.tier;
          const preferredTier = findModelMapping(requestedModel)?.tier;
          this.config.logger.warn(
            { requestedModel, usedProvider: provider, usedModel: model, usedTier, preferredTier },
            'ai-router: fallback occurred'
          );
        }

        return {
          provider,
          model,
          requestedModel,
          response,
        };
      } catch (err) {
        if (err instanceof ProviderError) {
          const headers = normalizeHeaders(
            err.headers as Record<string, string | string[]>
          );
          this.config.rateLimitTracker.update(provider, model, headers, err.status);
          this.config.circuitBreaker.recordFailure(provider, err.status);

          if (err.status === 429 || err.status >= 500) {
            // Try next provider
            continue;
          }

          // 4xx client errors (except 429) — propagate immediately
          throw err;
        }

        // Unexpected error
        throw err;
      }
    }

    throw new AllProvidersExhaustedError('All providers are unavailable or rate-limited');
  }

  buildFallbackChain(
    requestedModel: string,
    _capability: Capability,
    _strategy: RoutingStrategy
  ): FallbackChainEntry[] {
    const chain: FallbackChainEntry[] = [];

    for (const provider of this.config.providerPriority) {
      if (!this.config.adapters.has(provider)) continue;

      const model = getModelForProvider(requestedModel, provider);
      if (model === null) continue;

      chain.push({ provider, model });
    }

    // If no mapping found, try each provider with the raw model name
    // (useful for direct provider-specific model names)
    if (chain.length === 0) {
      for (const provider of this.config.providerPriority) {
        if (this.config.adapters.has(provider)) {
          chain.push({ provider, model: requestedModel });
          break; // Only add first available
        }
      }
    }

    return chain;
  }

  getAllCandidates(requestedModel: string, capability: Capability): FallbackChainEntry[] {
    return this.buildFallbackChain(requestedModel, capability, 'fallback');
  }

  get circuitBreaker(): CircuitBreaker {
    return this.config.circuitBreaker;
  }

  get rateLimitTracker(): RateLimitTracker {
    return this.config.rateLimitTracker;
  }

  get queue(): RequestQueue {
    return this.config.queue;
  }
}

export class AllProvidersExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllProvidersExhaustedError';
  }
}

// Re-export for use in type imports
export type { ProviderAdapter };
export { ProviderEnum, getModelForProvider, getCapabilityForModel, MODEL_MAPPINGS };
