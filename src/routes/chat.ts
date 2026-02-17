import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { type Router } from '../core/Router.js';
import { getCapabilityForModel } from '../types/provider.js';
import { type NormalizedChatRequest } from '../types/request.js';
import { normalizeStream } from '../streaming/normalizer.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requestIdMiddleware } from '../middleware/requestId.js';

export function createChatRoutes(router: Router, routerApiKey: string) {
  const authMiddleware = createAuthMiddleware(routerApiKey);

  return async function chatRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.post(
      '/v1/chat/completions',
      {
        preHandler: [requestIdMiddleware, authMiddleware],
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as NormalizedChatRequest;

        if (!body?.model) {
          return reply.status(400).send({
            error: {
              message: 'Missing required field: model',
              type: 'invalid_request_error',
              code: 'missing_model',
            },
          });
        }

        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
          return reply.status(400).send({
            error: {
              message: 'Missing required field: messages',
              type: 'invalid_request_error',
              code: 'missing_messages',
            },
          });
        }

        const requestedModel = body.model;
        const capability = getCapabilityForModel(requestedModel);

        const controller = new AbortController();

        // Abort when client disconnects
        request.raw.on('close', () => {
          if (!request.raw.complete) {
            controller.abort();
          }
        });

        try {
          const executeResult = await router.execute(
            requestedModel,
            capability,
            controller.signal,
            undefined,
            body
          );

          // Async queued job
          if ('mode' in executeResult) {
            // Async queued job
            return reply.status(202).send({
              id: executeResult.jobId,
              object: 'queue.job',
              status: 'pending',
              estimated_wait_ms: executeResult.estimatedWaitMs,
              poll_url: `/v1/queue/${executeResult.jobId}`,
            });
          }

          // RouterResult — has provider, model, response
          const routerResult = executeResult;

          // Handle streaming
          if (body.stream && routerResult.response.stream) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no'); // Critical for nginx

            for await (const chunk of normalizeStream(
              routerResult.response.stream,
              routerResult.provider,
              requestedModel
            )) {
              if (reply.raw.destroyed) break;
              reply.raw.write(chunk);
            }

            reply.raw.end();
            return;
          }

          // Non-streaming response
          return reply.status(200).send(routerResult.response.body);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            return reply.status(499).send({
              error: {
                message: 'Request cancelled by client',
                type: 'request_cancelled',
                code: 'client_closed_request',
              },
            });
          }

          const statusCode =
            err && typeof err === 'object' && 'status' in err
              ? (err as { status: number }).status
              : 500;

          const message =
            err instanceof Error ? err.message : 'Internal server error';

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
