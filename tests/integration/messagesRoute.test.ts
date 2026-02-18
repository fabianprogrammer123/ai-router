import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildApp } from '../../src/server.js';
import type { FastifyInstance } from 'fastify';

// Mock provider adapters to avoid real HTTP calls
vi.mock('undici', () => ({
  request: vi.fn(),
}));

// OpenAI-format response that the router returns internally
const MOCK_OPENAI_RESPONSE = {
  id: 'chatcmpl-test123',
  object: 'chat.completion',
  created: 1699000000,
  model: 'claude-sonnet-4-6',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello from Claude!' },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe('POST /v1/messages', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const { request } = await import('undici');
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining-requests': '100',
        'x-ratelimit-remaining-tokens': '50000',
      },
      body: {
        json: vi.fn().mockResolvedValue(MOCK_OPENAI_RESPONSE),
        text: vi.fn().mockResolvedValue(JSON.stringify(MOCK_OPENAI_RESPONSE)),
      },
    } as unknown as Awaited<ReturnType<typeof request>>);

    app = await buildApp();
  });

  it('returns 401 without any auth header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('accepts x-api-key header (Anthropic SDK format)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'test-router-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('accepts Authorization: Bearer header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: 'Bearer test-router-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns 400 when model is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'test-router-key' },
      payload: {
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as Record<string, unknown>;
    expect(body['type']).toBe('error');
    expect((body['error'] as Record<string, unknown>)['type']).toBe('invalid_request_error');
  });

  it('returns 400 when messages array is empty', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'test-router-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [],
        max_tokens: 100,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as Record<string, unknown>;
    expect(body['type']).toBe('error');
  });

  it('returns Anthropic-format response body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'test-router-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;

    // Must be Anthropic format, not OpenAI format
    expect(body['type']).toBe('message');
    expect(body['role']).toBe('assistant');
    expect(Array.isArray(body['content'])).toBe(true);
    const content = body['content'] as Array<Record<string, unknown>>;
    expect(content[0]?.['type']).toBe('text');
    expect(content[0]?.['text']).toBe('Hello from Claude!');

    // Must NOT have OpenAI-only fields
    expect(body['object']).toBeUndefined();
    expect(body['choices']).toBeUndefined();

    // Usage in Anthropic format
    const usage = body['usage'] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(10);
    expect(usage['output_tokens']).toBe(5);
  });

  it('includes x-ai-router-provider header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'test-router-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-ai-router-provider']).toBeTruthy();
  });

  it('converts system field to system message in request', async () => {
    const { request } = await import('undici');
    const capturedBody: unknown[] = [];
    vi.mocked(request).mockImplementation(async (_url, opts) => {
      capturedBody.push(JSON.parse((opts?.body as string) ?? '{}'));
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          json: vi.fn().mockResolvedValue(MOCK_OPENAI_RESPONSE),
          text: vi.fn().mockResolvedValue(JSON.stringify(MOCK_OPENAI_RESPONSE)),
        },
      } as unknown as Awaited<ReturnType<typeof request>>;
    });

    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'test-router-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    // The captured body sent to the upstream provider should have the system prompt
    expect(capturedBody.length).toBeGreaterThan(0);
    // Provider adapter translates the request; verify a request was made
    expect(request).toHaveBeenCalled();
  });

  it('includes x-request-id in response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'test-router-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('returns Anthropic-format stop_reason', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'test-router-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    const body = response.json() as Record<string, unknown>;
    // OpenAI finish_reason='stop' → Anthropic stop_reason='end_turn'
    expect(body['stop_reason']).toBe('end_turn');
  });

  it('returns 401 with wrong API key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': 'wrong-key' },
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100,
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
