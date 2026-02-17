import { timingSafeEqual, createHash } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Timing-safe Bearer token verification.
 * Prevents timing attacks by using crypto.timingSafeEqual.
 */
export function createAuthMiddleware(routerApiKey: string) {
  // Pre-hash the key to ensure fixed-length comparison
  const expectedBuffer = createHash('sha256').update(routerApiKey).digest();

  return async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      await reply.status(401).send({
        error: {
          message: 'Missing Authorization header',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      await reply.status(401).send({
        error: {
          message: 'Authorization header must use Bearer scheme',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
      return;
    }

    const providedKey = authHeader.slice(7).trim();
    const providedBuffer = createHash('sha256').update(providedKey).digest();

    let isValid = false;
    try {
      isValid = timingSafeEqual(expectedBuffer, providedBuffer);
    } catch {
      isValid = false;
    }

    if (!isValid) {
      await reply.status(401).send({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
  };
}
