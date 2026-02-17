/**
 * OpenAI stream pass-through — already in the correct format
 */
export async function* normalizeOpenAIStream(
  stream: AsyncIterable<string>
): AsyncIterable<string> {
  for await (const chunk of stream) {
    yield chunk;
  }
}
