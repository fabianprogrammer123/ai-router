import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { type Router } from '../core/Router.js';
import { getCapabilityForModel } from '../types/provider.js';
import { type NormalizedChatRequest } from '../types/request.js';
import { normalizeStream } from '../streaming/normalizer.js';
import { toAnthropicStream, openAIResponseToAnthropic, generateMessageId } from '../streaming/anthropicOutput.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { requestIdMiddleware } from '../middleware/requestId.js';

/**
 * Anthropic-native /v1/messages endpoint.
 *
 * Accepts requests in Anthropic SDK format (x-api-key auth, Anthropic body schema)
 * and returns responses in Anthropic format, regardless of which backend provider
 * served the request.
 *
 * This allows ClawdBot (Claude Code CLI) and other Anthropic SDK clients to point
 * at the router by setting:
 *   ANTHROPIC_API_KEY=<ROUTER_API_KEY>
 *   ANTHROPIC_BASE_URL=http://<router-host>
 */
export function createMessagesRoutes(router: Router, routerApiKey: string) {
  const authMiddleware = createAuthMiddleware(routerApiKey);

  return async function messagesRoutes(fastify: FastifyInstance): Promise<void> {
    fastify.post(
      '/v1/messages',
      {
        preHandler: [requestIdMiddleware, authMiddleware],
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Record<string, unknown>;

        if (!body?.model || typeof body.model !== 'string') {
          return reply.status(400).send({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Missing required field: model',
            },
          });
        }

        const messages = body.messages as Array<Record<string, unknown>> | undefined;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
          return reply.status(400).send({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Missing required field: messages',
            },
          });
        }

        // Convert Anthropic request format → internal OpenAI format
        const openAIBody = anthropicToOpenAI(body);
        const requestedModel = body.model;
        const capability = getCapabilityForModel(requestedModel);
        const msgId = generateMessageId();

        const controller = new AbortController();
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
            openAIBody
          );

          // Async queued job — return 202 in Anthropic-compatible format
          if ('mode' in executeResult) {
            return reply.status(202).send({
              id: executeResult.jobId,
              type: 'message',
              role: 'assistant',
              status: 'pending',
              estimated_wait_ms: executeResult.estimatedWaitMs,
              poll_url: `/v1/queue/${executeResult.jobId}`,
            });
          }

          const routerResult = executeResult;
          void reply.header('x-ai-router-provider', routerResult.provider);
          void reply.header('x-ai-router-model', routerResult.model);

          // Streaming response
          if (openAIBody.stream && routerResult.response.stream) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');

            // normalizeStream: provider-specific chunks → OpenAI SSE format
            // toAnthropicStream: OpenAI SSE chunks → Anthropic SSE events
            const openAIChunks = normalizeStream(
              routerResult.response.stream,
              routerResult.provider,
              requestedModel
            );

            for await (const chunk of toAnthropicStream(openAIChunks, msgId, requestedModel)) {
              if (reply.raw.destroyed) break;
              reply.raw.write(chunk);
            }

            reply.raw.end();
            return;
          }

          // Non-streaming: convert OpenAI response body → Anthropic format
          const anthropicBody = openAIResponseToAnthropic(
            routerResult.response.body as Record<string, unknown>,
            requestedModel
          );

          // Anthropic SDK expects the id field to be stable across retries;
          // use the msgId we generated unless the upstream already provided one.
          if (!anthropicBody['id']) {
            anthropicBody['id'] = msgId;
          }

          return reply.status(200).send(anthropicBody);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            return reply.status(499).send({
              type: 'error',
              error: {
                type: 'request_cancelled',
                message: 'Request cancelled by client',
              },
            });
          }

          const statusCode =
            err && typeof err === 'object' && 'status' in err
              ? (err as { status: number }).status
              : 500;

          const message = err instanceof Error ? err.message : 'Internal server error';
          const errorType = statusCode >= 500 ? 'api_error' : 'invalid_request_error';

          return reply.status(statusCode).send({
            type: 'error',
            error: { type: errorType, message },
          });
        }
      }
    );
  };
}

/**
 * Convert an Anthropic SDK request body to the router's internal OpenAI-compatible format.
 *
 * Anthropic format:
 *   { model, messages: [{role: 'user'|'assistant', content: string}], system?, max_tokens, stream?, ... }
 *
 * OpenAI format (NormalizedChatRequest):
 *   { model, messages: [{role: 'system'|'user'|'assistant', content: string}], max_tokens?, stream?, ... }
 */
function anthropicToOpenAI(body: Record<string, unknown>): NormalizedChatRequest {
  const anthropicMessages = (body.messages as Array<Record<string, unknown>>) ?? [];

  // Build the messages array; prepend system message if present
  const messages: NormalizedChatRequest['messages'] = [];

  const system = body.system as string | undefined;
  if (system) {
    messages.push({ role: 'system', content: system });
  }

  for (const msg of anthropicMessages) {
    const role = msg['role'] as string;
    const content = msg['content'];

    if (role === 'user' || role === 'assistant') {
      if (typeof content === 'string') {
        messages.push({ role, content });
      } else if (Array.isArray(content)) {
        // Anthropic content blocks: [{type:'text', text:'...'}, ...]
        const text = (content as Array<Record<string, unknown>>)
          .filter((b) => b['type'] === 'text')
          .map((b) => String(b['text'] ?? ''))
          .join('');
        messages.push({ role, content: text });
      }
    }
  }

  const openAIBody: NormalizedChatRequest = {
    model: body.model as string,
    messages,
  };

  if (body.max_tokens !== undefined) openAIBody.max_tokens = body.max_tokens as number;
  if (body.temperature !== undefined) openAIBody.temperature = body.temperature as number;
  if (body.top_p !== undefined) openAIBody.top_p = body.top_p as number;
  if (body.stream !== undefined) openAIBody.stream = body.stream as boolean;

  const stop = body.stop_sequences;
  if (Array.isArray(stop)) openAIBody.stop = stop as string[];

  return openAIBody;
}
