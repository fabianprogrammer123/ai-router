import { randomUUID } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Attaches a unique x-request-id to every request and response.
 * Reuses existing x-request-id header if provided by the client.
 */
export async function requestIdMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const existing = request.headers['x-request-id'];
  const requestId =
    typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();

  // Attach to request for use in handlers
  request.requestId = requestId;

  // Include in response headers
  void reply.header('x-request-id', requestId);
}

// Augment FastifyRequest to include requestId
declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}
