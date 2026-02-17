import { AnthropicAdapter } from '../providers/anthropic.js';

/**
 * Normalize Anthropic SSE stream → OpenAI SSE format
 */
export async function* normalizeAnthropicStream(
  stream: AsyncIterable<string>,
  requestedModel: string
): AsyncIterable<string> {
  // Use the adapter's conversion logic
  const adapter = new AnthropicAdapter('');

  for await (const chunk of stream) {
    // chunk may contain multiple lines
    const lines = chunk.split('\n');
    for (const line of lines) {
      const converted = adapter.convertStreamLine(line, requestedModel);
      if (converted) yield converted;
    }
  }
}
