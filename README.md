# AI Router

A production-grade AI API routing service that sits between your application and AI providers (OpenAI, Anthropic, Google). It automatically handles rate limits, fallback routing, request queuing, and response normalization — all behind an OpenAI-compatible API so existing apps need **only a base URL change**.

## Architecture

```
Your App (unchanged OpenAI SDK call)
    │ POST /v1/chat/completions
    │ Authorization: Bearer <ROUTER_API_KEY>
    ▼
┌─────────────────────── AI Router ──────────────────────────┐
│  Auth → Route Handler → Router.execute()                   │
│    ├── CircuitBreaker (per provider: closed/open/half-open)│
│    ├── RateLimitTracker (token bucket + header parsing)    │
│    │    proactive: remaining < threshold → skip provider   │
│    │    reactive: 429 → set cooldown TTL from Retry-After  │
│    ├── Fallback Chain: OpenAI → Anthropic → Google         │
│    │    (configurable priority order)                      │
│    ├── Provider Adapter (request/response translation)     │
│    └── RequestQueue (when ALL providers rate limited)      │
│         ├── short wait (<5s): block inline, return 200     │
│         └── long wait (>5s): return 202 + poll URL        │
└────────────────────────────────────────────────────────────┘
    │                │                │
  OpenAI          Anthropic         Google
```

## Features

- **Automatic fallback**: If OpenAI hits a rate limit, requests automatically route to Anthropic or Google
- **Proactive rate limit avoidance**: Parses `x-ratelimit-remaining-*` headers to skip providers before hitting limits
- **Circuit breaker**: Automatically stops routing to providers experiencing 5xx errors
- **Request queue**: All-providers-exhausted scenarios are queued and auto-retried
- **OpenAI-compatible API**: Drop-in replacement — just change the `baseURL`
- **Streaming support**: SSE streams normalized to OpenAI format across all providers
- **Model tier mapping**: Automatically maps equivalent models (gpt-4o ↔ claude-opus-4-6 ↔ gemini-1.5-pro)

## Quick Start

### With Docker Compose

```bash
# 1. Clone the repo
git clone https://github.com/fabianprogrammer123/ai-router
cd ai-router

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Start
docker compose up -d

# 4. Test
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-router-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

### Connecting Existing Apps

Only a single line change needed:

```typescript
// Before
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// After
const openai = new OpenAI({
  apiKey: process.env.ROUTER_API_KEY,
  baseURL: 'https://your-router.example.com/v1',
});
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ROUTER_API_KEY` | ✅ | — | Key your apps use to authenticate with the router |
| `OPENAI_API_KEY` | * | — | OpenAI API key (\*at least one provider required) |
| `ANTHROPIC_API_KEY` | * | — | Anthropic API key |
| `GOOGLE_API_KEY` | * | — | Google AI API key |
| `REDIS_URL` | | — | Redis URL — enables persistent state + multi-instance coordination |
| `PORT` | | `3000` | Server port |
| `PROVIDER_PRIORITY` | | `openai,anthropic,google` | Fallback order |
| `DEFAULT_ROUTING_STRATEGY` | | `fallback` | `fallback`, `round-robin`, or `latency` |
| `QUEUE_MAX_SIZE` | | `100` | Max queued requests |
| `QUEUE_TIMEOUT_MS` | | `30000` | Queue timeout (ms) |
| `QUEUE_ASYNC_THRESHOLD_MS` | | `5000` | Wait threshold for 202 async response (ms) |
| `CB_FAILURE_THRESHOLD` | | `5` | 5xx failures to open circuit breaker |
| `CB_COOLDOWN_MS` | | `60000` | Circuit breaker cooldown (ms) |
| `RATE_LIMIT_LOW_REQUESTS_THRESHOLD` | | `5` | Skip provider when remaining < this |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions — OpenAI SDK format |
| `POST` | `/v1/messages` | Chat completions — Anthropic SDK format |
| `POST` | `/v1/images/generations` | Image generation |
| `POST` | `/v1/embeddings` | Text embeddings |
| `GET` | `/health` | Health check |
| `GET` | `/v1/providers/status` | Live rate limit + circuit breaker state |
| `GET` | `/v1/queue/:jobId` | Poll async queued request |

### Response headers (all endpoints)

| Header | Description |
|--------|-------------|
| `x-ai-router-provider` | Which provider actually served the request (`openai`, `anthropic`, `google`) |
| `x-ai-router-model` | Which provider-side model name was used |
| `x-request-id` | Request tracing ID (echoes your `x-request-id` if provided) |

Use these headers to detect when fallback routing occurred.

### Anthropic SDK integration (`/v1/messages`)

Point the Anthropic SDK (or Claude Code CLI) at the router by setting two environment variables:

```bash
ANTHROPIC_API_KEY=your-router-key   # same key as ROUTER_API_KEY
ANTHROPIC_BASE_URL=http://localhost:3000
```

The router accepts the full Anthropic request format (`system`, `messages`, `max_tokens`, `stream`, `stop_sequences`, etc.) and returns Anthropic-format responses (`type: "message"`, `content: [{type:"text", text:"..."}]`, `stop_reason`, `usage.input_tokens`, etc.).

Streaming also works — the router converts provider streams to the Anthropic event format (`event: content_block_delta`, etc.) regardless of which backend provider served the request.

```bash
# ClawdBot / Claude Code CLI — just set env vars, no code changes
export ANTHROPIC_API_KEY=your-router-key
export ANTHROPIC_BASE_URL=http://your-router-host

# Verify
curl -X POST http://localhost:3000/v1/messages \
  -H "x-api-key: your-router-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

## Model Mapping

| Tier | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| Premium | `gpt-4o` | `claude-opus-4-6` | `gemini-1.5-pro` |
| Standard | `gpt-4o-mini` | `claude-sonnet-4-6` | `gemini-1.5-flash` |
| Economy | `gpt-3.5-turbo` | `claude-haiku-4-5` | `gemini-1.5-flash` |
| Images | `dall-e-3` | — | `imagen-3.0-generate-001` |
| Embeddings | `text-embedding-3-*` | — | — |

Bidirectional: sending `claude-opus-4-6` also gets cross-provider fallback. Responses always preserve the client's original model name.

## Async Queue Flow

When all providers are rate-limited:

1. Router calculates estimated wait time from `x-ratelimit-reset-*` headers
2. If wait < 5s: blocks inline and returns `200` when provider becomes available
3. If wait > 5s: immediately returns `202` with a job ID
4. Client polls `GET /v1/queue/:jobId` until `status: "done"`

```bash
# Returns: 202 with jobId
curl -X POST http://localhost:3000/v1/chat/completions -d '...'
# {"id":"uuid","status":"pending","poll_url":"/v1/queue/uuid","estimated_wait_ms":12000}

# Poll until done
curl http://localhost:3000/v1/queue/uuid
# {"status":"done"} → returns normal OpenAI response body
```

## Simulating Rate Limits (Testing)

```bash
# Force proactive avoidance for all providers
RATE_LIMIT_LOW_REQUESTS_THRESHOLD=9999 docker compose up

# All requests will use fallback chain — verify in logs
curl -X POST http://localhost:3000/v1/providers/status
```

## Development

```bash
npm install
cp .env.example .env  # fill in keys

# Development (hot reload)
npm run dev

# Tests
npm test
npm run test:coverage

# Type checking
npm run typecheck

# Lint
npm run lint
```

## Redis — Persistent State

By default the router runs fully in-memory. Adding `REDIS_URL` enables:

- **State persistence** — rate limit cooldowns and circuit breaker state survive restarts
- **Multi-instance coordination** — run multiple router instances behind a load balancer; all share the same rate limit view and async job queue

```bash
# docker-compose.yml already includes Redis — just start it:
docker compose up -d

# Or point to an existing Redis:
REDIS_URL=redis://localhost:6379
```

If Redis becomes unavailable, the router **falls back to in-memory automatically** — no crashes, no dropped requests. Logs a warning: `ai-router: Redis connection error — running in-memory fallback`.

## Response Headers

Every successful response includes:

| Header | Example | Description |
|--------|---------|-------------|
| `x-ai-router-provider` | `openai` | Which provider served the request |
| `x-ai-router-model` | `gpt-4o` | Which model was used |

These let you detect when fallback routing occurred:

```typescript
const res = await openai.chat.completions.create({ ... });
// Check via raw HTTP headers if using fetch:
const provider = response.headers.get('x-ai-router-provider');
if (provider !== 'openai') console.warn(`Fallback: served by ${provider}`);
```

## Deployment

See [docs/deployment.md](docs/deployment.md) for full guides covering Railway, Render, Fly.io, VPS, and local Docker.

### Quick — Manual Docker
```bash
docker build -f docker/Dockerfile -t ai-router .
docker run -p 3000:3000 --env-file .env ai-router
```

### Scale to multiple instances
```bash
# Requires Redis (included in docker-compose.yml)
docker compose up -d --scale ai-router=2
# Add nginx (see docker/nginx.conf) for load balancing
```

## Security

- `crypto.timingSafeEqual` for API key comparison (timing-attack safe)
- Authorization headers redacted from all logs
- Non-root Docker user (UID 1001)
- Provider API keys stored as env vars only — never in code or git history

## License

MIT
