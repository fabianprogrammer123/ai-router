# Claude Coach Integration Guide

## What Is AI Router?

AI Router is an OpenAI API-compatible proxy that automatically routes requests across OpenAI, Anthropic, and Google. It handles:

- **Automatic fallback** — if one provider is rate-limited or down, requests transparently route to the next
- **Proactive rate limit avoidance** — reads response headers to skip providers before hitting limits
- **Circuit breaker** — stops routing to providers with repeated 5xx errors
- **Request queuing** — when all providers are exhausted, requests queue and auto-retry

Because it's OpenAI-compatible, integrating it requires **only a base URL change**. No API changes. No SDK changes.

---

## Integration Prompt (Copy-Paste into Claude Code)

Use this prompt to have Claude Code wire up an existing project to use the router:

---

```
I have an AI router running at [ROUTER_URL] that proxies OpenAI, Anthropic, and Google.
It's fully OpenAI API-compatible — the only change needed is the baseURL.

Please update this codebase to route all AI API calls through the router:

1. Find every place an OpenAI, Anthropic, or Google AI client is instantiated, or where
   raw fetch/axios calls are made to api.openai.com, api.anthropic.com, or generativelanguage.googleapis.com

2. For OpenAI SDK usage: change baseURL to [ROUTER_URL]/v1 and apiKey to ROUTER_API_KEY

3. For Anthropic SDK usage: the router accepts OpenAI format, so replace AnthropicClient with
   an OpenAI client pointed at the router (same models, they'll be translated automatically)

4. For raw HTTP calls: update the base URL to [ROUTER_URL]/v1

5. Update .env.example / environment docs to add:
   ROUTER_URL=[ROUTER_URL]
   ROUTER_API_KEY=[your router key]

6. If you encounter a 202 response with a poll_url field, add polling logic:
   (see polling snippet below)

7. Do NOT remove the original provider keys from .env — they may be needed as fallback docs

Polling snippet for 202 async responses:
---
async function pollForResult(pollUrl: string, apiKey: string, maxAttempts = 60): Promise<unknown> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const data = await res.json();
    if (data.status === 'done') return data;
    if (data.status === 'error') throw new Error(data.error?.message ?? 'Queue processing failed');
    if (data.status === 'expired') throw new Error('Request timed out in queue');
  }
  throw new Error('Polling timed out after max attempts');
}
---

Environment variables to add:
  ROUTER_URL=[ROUTER_URL]
  ROUTER_API_KEY=[your-router-key]
```

---

## Node.js / TypeScript Example

**Before:**
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

**After (only 2 lines change):**
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.ROUTER_API_KEY,        // changed
  baseURL: `${process.env.ROUTER_URL}/v1`,   // added
});

const response = await openai.chat.completions.create({
  model: 'gpt-4o',  // unchanged — router maps to best available provider
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

---

## Python Example

**Before:**
```python
from openai import OpenAI

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

**After (only 2 lines change):**
```python
from openai import OpenAI
import os

client = OpenAI(
    api_key=os.getenv("ROUTER_API_KEY"),         # changed
    base_url=f"{os.getenv('ROUTER_URL')}/v1",    # added
)
response = client.chat.completions.create(
    model="gpt-4o",  # unchanged
    messages=[{"role": "user", "content": "Hello!"}]
)
```

---

## One-Command Verification

```bash
curl -s http://your-router.example.com/health
# Expected: {"status":"ok"}

# Full round-trip test:
curl -X POST http://your-router.example.com/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Reply with one word: OK"}]}' \
  -v 2>&1 | grep -E "(x-ai-router|choices)"
# x-ai-router-provider: openai   ← or anthropic/google if fallback occurred
# x-ai-router-model: gpt-4o
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Wrong `ROUTER_API_KEY` | Check the key in your router's `.env` matches what your app sends |
| `400 Missing required field: model` | Request body missing `model` field | Ensure your SDK call includes the `model` parameter |
| `202` response instead of `200` | All providers rate-limited; request queued | Implement polling logic (see snippet above) or increase `QUEUE_ASYNC_THRESHOLD_MS` |
| `404 Queue job not found` | Polling a job that already completed or expired | Jobs expire after 30s (configurable via `QUEUE_TIMEOUT_MS`); poll more frequently |
| Provider keeps failing over | Circuit breaker opened | Check `/v1/providers/status` — circuit auto-recovers after `CB_COOLDOWN_MS` (default 60s) |

---

## Detecting Fallback in Your App

The router adds two response headers you can inspect:

```typescript
const response = await fetch(`${ROUTER_URL}/v1/chat/completions`, { ... });

const provider = response.headers.get('x-ai-router-provider'); // 'openai' | 'anthropic' | 'google'
const model = response.headers.get('x-ai-router-model');       // actual model used

if (provider !== 'openai') {
  console.warn(`Fallback occurred: served by ${provider} using ${model}`);
}
```
