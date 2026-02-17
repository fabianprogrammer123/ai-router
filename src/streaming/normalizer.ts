import { type Provider } from '../types/provider.js';
import { normalizeOpenAIStream } from './openaiStream.js';
import { normalizeAnthropicStream } from './anthropicStream.js';
import { normalizeGoogleStream } from './googleStream.js';

/**
 * Main streaming normalizer entry point.
 * Routes stream normalization to the appropriate provider-specific normalizer.
 * All normalizers output OpenAI SSE format (text/event-stream).
 */
export async function* normalizeStream(
  stream: AsyncIterable<string>,
  provider: Provider,
  requestedModel: string
): AsyncIterable<string> {
  switch (provider) {
    case 'openai':
      yield* normalizeOpenAIStream(stream);
      break;

    case 'anthropic':
      yield* normalizeAnthropicStream(stream, requestedModel);
      break;

    case 'google':
      yield* normalizeGoogleStream(stream, requestedModel);
      break;

    default:
      // Unknown provider — pass through as-is and add [DONE]
      yield* stream;
      yield 'data: [DONE]\n\n';
  }
}
