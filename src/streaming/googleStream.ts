import { GoogleAdapter } from '../providers/google.js';

/**
 * Normalize Google NDJSON stream → OpenAI SSE format
 */
export async function* normalizeGoogleStream(
  stream: AsyncIterable<string>,
  requestedModel: string
): AsyncIterable<string> {
  const adapter = new GoogleAdapter('');

  for await (const chunk of stream) {
    const lines = chunk.split('\n');
    for (const line of lines) {
      const converted = adapter.convertStreamLine(line, requestedModel);
      if (converted) yield converted;
    }
  }

  yield 'data: [DONE]\n\n';
}
