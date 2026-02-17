import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildApp } from '../../src/server.js';
import type { FastifyInstance } from 'fastify';

// Mock the provider adapters to avoid real HTTP calls
vi.mock('undici', () => ({
  request: vi.fn(),
}));

const MOCK_CHAT_RESPONSE = {
  id: 'chatcmpl-test123',
  object: 'chat.completion',
  created: 1699000000,
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe('POST /v1/chat/completions', () => {
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
        json: vi.fn().mockResolvedValue(MOCK_CHAT_RESPONSE),
        text: vi.fn().mockResolvedValue(JSON.stringify(MOCK_CHAT_RESPONSE)),
      },
    } as unknown as Awaited<ReturnType<typeof request>>);

    app = await buildApp();
  });

  it('returns 401 without Authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 with wrong API key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer wrong-key' },
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 400 when model is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-router-key' },
      payload: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as Record<string, unknown>;
    expect(body['error']).toBeTruthy();
  });

  it('returns 400 when messages are missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-router-key' },
      payload: {
        model: 'gpt-4o',
        messages: [],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 200 with valid request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-router-key' },
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['object']).toBe('chat.completion');
    expect(body['choices']).toBeTruthy();
  });

  it('includes x-request-id in response headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-router-key' },
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('preserves provided x-request-id', async () => {
    const customId = 'my-custom-request-id';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer test-router-key',
        'x-request-id': customId,
      },
      payload: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.headers['x-request-id']).toBe(customId);
  });
});

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  it('returns 200 with status ok', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('ai-router');
  });
});

describe('GET /v1/providers/status', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  it('returns provider status without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/providers/status',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['providers']).toBeTruthy();
    expect(Array.isArray(body['providers'])).toBe(true);
  });
});
