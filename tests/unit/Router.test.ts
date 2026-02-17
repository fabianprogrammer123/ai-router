import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router } from '../../src/core/Router.js';
import { CircuitBreaker } from '../../src/core/CircuitBreaker.js';
import { RateLimitTracker } from '../../src/core/RateLimitTracker.js';
import { RequestQueue } from '../../src/core/RequestQueue.js';
import { Provider, Capability } from '../../src/types/provider.js';
import { ProviderError } from '../../src/types/request.js';
import type { ProviderAdapter } from '../../src/providers/base.js';
import type { ProviderResponse } from '../../src/types/request.js';

function makeMockAdapter(response?: Partial<ProviderResponse>): ProviderAdapter {
  return {
    call: vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: { choices: [{ message: { content: 'test' } }] },
      ...response,
    }),
  };
}

function makeRouter(overrides?: {
  openaiAdapter?: ProviderAdapter;
  anthropicAdapter?: ProviderAdapter;
}) {
  const cb = new CircuitBreaker(3, 60000);
  const rlt = new RateLimitTracker(5);
  const queue = new RequestQueue(10, 30000, 5000);

  const adapters = new Map<Provider, ProviderAdapter>([
    [Provider.OpenAI, overrides?.openaiAdapter ?? makeMockAdapter()],
    [Provider.Anthropic, overrides?.anthropicAdapter ?? makeMockAdapter()],
  ]);

  return new Router({
    providerPriority: [Provider.OpenAI, Provider.Anthropic],
    defaultStrategy: 'fallback',
    circuitBreaker: cb,
    rateLimitTracker: rlt,
    queue,
    adapters,
  });
}

describe('Router', () => {
  describe('execute', () => {
    it('calls the first provider in priority order', async () => {
      const openaiAdapter = makeMockAdapter();
      const router = makeRouter({ openaiAdapter });

      const controller = new AbortController();
      const result = await router.execute('gpt-4o', Capability.Chat, controller.signal);

      expect('provider' in result).toBe(true);
      if ('provider' in result) {
        expect(result.provider).toBe(Provider.OpenAI);
      }
      expect(openaiAdapter.call).toHaveBeenCalledOnce();
    });

    it('falls back to next provider on 429', async () => {
      const openaiAdapter: ProviderAdapter = {
        call: vi.fn().mockRejectedValue(
          new ProviderError('openai', 429, { 'retry-after': '30' }, 'Rate limited')
        ),
      };
      const anthropicAdapter = makeMockAdapter();
      const router = makeRouter({ openaiAdapter, anthropicAdapter });

      const controller = new AbortController();
      const result = await router.execute('gpt-4o', Capability.Chat, controller.signal);

      expect('provider' in result).toBe(true);
      if ('provider' in result) {
        expect(result.provider).toBe(Provider.Anthropic);
      }
    });

    it('falls back to next provider on 500', async () => {
      const openaiAdapter: ProviderAdapter = {
        call: vi.fn().mockRejectedValue(
          new ProviderError('openai', 500, {}, 'Server error')
        ),
      };
      const anthropicAdapter = makeMockAdapter();
      const router = makeRouter({ openaiAdapter, anthropicAdapter });

      const controller = new AbortController();
      const result = await router.execute('gpt-4o', Capability.Chat, controller.signal);

      if ('provider' in result) {
        expect(result.provider).toBe(Provider.Anthropic);
      }
    });

    it('throws on 4xx client errors (not 429)', async () => {
      const openaiAdapter: ProviderAdapter = {
        call: vi.fn().mockRejectedValue(
          new ProviderError('openai', 400, {}, 'Bad request')
        ),
      };
      const router = makeRouter({ openaiAdapter });

      const controller = new AbortController();
      await expect(
        router.execute('gpt-4o', Capability.Chat, controller.signal)
      ).rejects.toThrow(ProviderError);
    });

    it('skips providers with open circuit breakers', async () => {
      const openaiAdapter: ProviderAdapter = {
        call: vi.fn().mockRejectedValue(
          new ProviderError('openai', 503, {}, 'Service unavailable')
        ),
      };
      const anthropicAdapter = makeMockAdapter();
      const router = makeRouter({ openaiAdapter, anthropicAdapter });

      const controller = new AbortController();

      // Open the circuit breaker for OpenAI
      for (let i = 0; i < 3; i++) {
        try {
          await router.execute('gpt-4o', Capability.Chat, controller.signal);
        } catch {
          // ignore
        }
      }

      // Reset mock to not throw
      vi.mocked(openaiAdapter.call).mockReset();

      // Next call should skip OpenAI (circuit open) and go to Anthropic
      const result = await router.execute('gpt-4o', Capability.Chat, controller.signal);
      if ('provider' in result) {
        expect(result.provider).toBe(Provider.Anthropic);
      }
      expect(openaiAdapter.call).not.toHaveBeenCalled();
    });

    it('skips providers when rate limit tracker says avoid', async () => {
      const openaiAdapter = makeMockAdapter();
      const anthropicAdapter = makeMockAdapter();
      const cb = new CircuitBreaker(3, 60000);
      const rlt = new RateLimitTracker(5);
      const queue = new RequestQueue(10, 30000, 5000);

      const adapters = new Map<Provider, ProviderAdapter>([
        [Provider.OpenAI, openaiAdapter],
        [Provider.Anthropic, anthropicAdapter],
      ]);

      const router = new Router({
        providerPriority: [Provider.OpenAI, Provider.Anthropic],
        defaultStrategy: 'fallback',
        circuitBreaker: cb,
        rateLimitTracker: rlt,
        queue,
        adapters,
      });

      // Mark OpenAI as rate-limited
      rlt.update(Provider.OpenAI, 'gpt-4o', { 'retry-after': '30' }, 429);

      const controller = new AbortController();
      const result = await router.execute('gpt-4o', Capability.Chat, controller.signal);
      if ('provider' in result) {
        expect(result.provider).toBe(Provider.Anthropic);
      }
      expect(openaiAdapter.call).not.toHaveBeenCalled();
    });
  });

  describe('buildFallbackChain', () => {
    it('builds chain in priority order', () => {
      const router = makeRouter();
      const chain = router.buildFallbackChain('gpt-4o', Capability.Chat, 'fallback');
      expect(chain[0]?.provider).toBe(Provider.OpenAI);
      expect(chain[1]?.provider).toBe(Provider.Anthropic);
    });

    it('maps models correctly for each provider', () => {
      const router = makeRouter();
      const chain = router.buildFallbackChain('gpt-4o', Capability.Chat, 'fallback');
      expect(chain[0]?.model).toBe('gpt-4o');
      expect(chain[1]?.model).toBe('claude-opus-4-6');
    });

    it('skips providers without adapters', () => {
      const router = makeRouter(); // Only OpenAI and Anthropic registered
      const chain = router.buildFallbackChain('gpt-4o', Capability.Chat, 'fallback');
      const providers = chain.map((e) => e.provider);
      expect(providers).not.toContain(Provider.Google);
    });
  });
});
