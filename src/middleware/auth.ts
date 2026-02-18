import { timingSafeEqual, createHash } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Timing-safe API key verification.
 * Accepts both:
 *   - OpenAI SDK format:    Authorization: Bearer <key>
 *   - Anthropic SDK format: x-api-key: <key>
 *
 * Both headers are checked against the router's ROUTER_API_KEY.
 * This allows ClawdBot (which uses the Anthropic SDK) to point at the router
 * by setting ANTHROPIC_API_KEY=<ROUTER_API_KEY>.
 */
export function createAuthMiddleware(routerApiKey: string) {
  // Pre-hash the key to ensure fixed-length comparison
  const expectedBuffer = createHash('sha256').update(routerApiKey).digest();

  return async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Extract token from whichever auth header is present
    const token = extractToken(request);

    if (!token) {
      await reply.status(401).send({
        error: {
          message: 'Missing authentication. Provide Authorization: Bearer <key> or x-api-key: <key>',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
      return;
    }

    const providedBuffer = createHash('sha256').update(token).digest();

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

/**
 * Extract the API key token from the request.
 * Priority: x-api-key header → Authorization: Bearer token
 */
function extractToken(request: FastifyRequest): string | null {
  // Anthropic SDK sends x-api-key
  const xApiKey = request.headers['x-api-key'];
  if (xApiKey && typeof xApiKey === 'string') {
    return xApiKey.trim();
  }

  // OpenAI SDK sends Authorization: Bearer <token>
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  return null;
}
