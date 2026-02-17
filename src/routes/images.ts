import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { type Router } from '../core/Router.js';
import { Capability } from '../types/provider.js';
import { type NormalizedImageRequest } from '../types/request.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requestIdMiddleware } from '../middleware/requestId.js';

export function createImageRoutes(router: Router, routerApiKey: string) {
  const authMiddleware = createAuthMiddleware(routerApiKey);

  return async function imageRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.post(
      '/v1/images/generations',
      {
        preHandler: [requestIdMiddleware, authMiddleware],
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as NormalizedImageRequest;

        if (!body?.prompt) {
          return reply.status(400).send({
            error: {
              message: 'Missing required field: prompt',
              type: 'invalid_request_error',
              code: 'missing_prompt',
            },
          });
        }

        const requestedModel = body.model ?? 'dall-e-3';
        const controller = new AbortController();

        request.raw.on('close', () => {
          if (!request.raw.complete) controller.abort();
        });

        try {
          const result = await router.execute(
            requestedModel,
            Capability.Images,
            controller.signal,
            undefined,
            body
          );

          if ('mode' in result) {
            return reply.status(202).send({
              id: result.jobId,
              object: 'queue.job',
              status: 'pending',
              estimated_wait_ms: result.estimatedWaitMs,
              poll_url: `/v1/queue/${result.jobId}`,
            });
          }

          return reply.status(200).send(result.response.body);
        } catch (err) {
          const statusCode =
            err && typeof err === 'object' && 'status' in err
              ? (err as { status: number }).status
              : 500;
          const message = err instanceof Error ? err.message : 'Internal server error';

          return reply.status(statusCode).send({
            error: {
              message,
              type: statusCode >= 500 ? 'api_error' : 'invalid_request_error',
              code: 'provider_error',
            },
          });
        }
      }
    );
  };
}
