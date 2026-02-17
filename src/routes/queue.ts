import type { FastifyInstance } from 'fastify';
import { type RequestQueue } from '../core/RequestQueue.js';

export function createQueueRoutes(queue: RequestQueue) {
  return async function queueRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.get<{ Params: { jobId: string } }>(
      '/v1/queue/:jobId',
      async (request, reply) => {
        const { jobId } = request.params;
        const result = await queue.poll(jobId);

        switch (result.status) {
          case 'not_found':
            return reply.status(404).send({
              error: {
                message: `Queue job '${jobId}' not found`,
                type: 'invalid_request_error',
                code: 'job_not_found',
              },
            });

          case 'pending':
            return reply.status(202).send({
              id: jobId,
              status: 'pending',
              message: 'Request is still being processed',
            });

          case 'done':
            return reply.status(200).send(result.result?.response.body);

          case 'error':
            return reply.status(500).send({
              error: {
                message: result.error ?? 'Unknown error processing request',
                type: 'api_error',
                code: 'queue_processing_error',
              },
            });

          case 'expired':
            return reply.status(408).send({
              error: {
                message: 'Request timed out waiting in queue',
                type: 'api_error',
                code: 'queue_timeout',
              },
            });
        }
      }
    );
  };
}
