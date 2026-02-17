import type { FastifyInstance } from 'fastify';
import { type Router } from '../core/Router.js';
import { Provider } from '../types/provider.js';

export function createStatusRoutes(router: Router) {
  return async function statusRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.get('/v1/providers/status', async (_request, reply) => {
      const providers = [Provider.OpenAI, Provider.Anthropic, Provider.Google];

      const statuses = providers.map((provider) => {
        const circuitState = router.circuitBreaker.getState(provider);
        const allStates = router.rateLimitTracker.getAllStates();

        // Aggregate rate limit state across all models for this provider
        let coolingDown = false;
        let earliestCooldownUntil: number | null = null;
        let minRemainingRequests: number | null = null;
        let minRemainingTokens: number | null = null;
        let resetRequestsAt: number | null = null;
        let resetTokensAt: number | null = null;

        for (const [key, state] of allStates.entries()) {
          if (!key.startsWith(`${provider}:`)) continue;

          if (state.coolingDown) {
            coolingDown = true;
            if (
              earliestCooldownUntil === null ||
              state.cooldownUntil < earliestCooldownUntil
            ) {
              earliestCooldownUntil = state.cooldownUntil;
            }
          }

          if (state.remainingRequests !== null) {
            if (minRemainingRequests === null || state.remainingRequests < minRemainingRequests) {
              minRemainingRequests = state.remainingRequests;
            }
          }

          if (state.remainingTokens !== null) {
            if (minRemainingTokens === null || state.remainingTokens < minRemainingTokens) {
              minRemainingTokens = state.remainingTokens;
            }
          }

          if (state.resetRequestsAt !== null) {
            if (resetRequestsAt === null || state.resetRequestsAt > resetRequestsAt) {
              resetRequestsAt = state.resetRequestsAt;
            }
          }

          if (state.resetTokensAt !== null) {
            if (resetTokensAt === null || state.resetTokensAt > resetTokensAt) {
              resetTokensAt = state.resetTokensAt;
            }
          }
        }

        return {
          provider,
          circuit_state: circuitState,
          cooling_down: coolingDown,
          cooldown_until_ms: earliestCooldownUntil,
          remaining_requests: minRemainingRequests,
          remaining_tokens: minRemainingTokens,
          reset_requests_at: resetRequestsAt ? new Date(resetRequestsAt).toISOString() : null,
          reset_tokens_at: resetTokensAt ? new Date(resetTokensAt).toISOString() : null,
        };
      });

      return reply.status(200).send({
        timestamp: new Date().toISOString(),
        providers: statuses,
        queue_size: router.queue.size,
      });
    });
  };
}
