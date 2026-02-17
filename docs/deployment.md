# AI Router — Deployment Guide

## Prerequisites

- Docker + Docker Compose (for containerised deployments)
- API keys for at least one provider (OpenAI, Anthropic, or Google)
- A `ROUTER_API_KEY` of your choice (this is what your apps use to authenticate)
- (Optional) Redis 6+ for persistent state and multi-instance coordination

---

## 1. Local — Docker Compose (recommended for development)

```bash
# Clone and enter directory
git clone https://github.com/fabianprogrammer123/ai-router
cd ai-router

# Create .env
cp .env.example .env
# Edit .env — set ROUTER_API_KEY and at least one provider key

# Start (includes Redis automatically)
docker compose up -d

# Verify
curl http://localhost:3000/health
```

**Scale to 2 instances** (requires Redis, included in docker-compose.yml):

```bash
docker compose up -d --scale ai-router=2
# Add nginx for load balancing (see docker/nginx.conf)
```

---

## 2. Railway

1. **Create project** — New Project → Deploy from GitHub repo → select `ai-router`
2. **Add Redis** — New → Database → Add Redis → copy the `REDIS_URL` it provides
3. **Set environment variables** (Railway Dashboard → Variables):

| Variable | Value |
|----------|-------|
| `ROUTER_API_KEY` | your secret key |
| `OPENAI_API_KEY` | sk-... |
| `ANTHROPIC_API_KEY` | sk-ant-... |
| `GOOGLE_API_KEY` | AIza... |
| `REDIS_URL` | (auto-populated from the Redis add-on) |
| `PORT` | `3000` |

4. **Deploy** — Railway auto-builds from `docker/Dockerfile`
5. **Verify** — `curl https://your-app.up.railway.app/health`

> **Note:** Railway provides a `REDIS_URL` in `rediss://` (TLS) format — the router accepts both `redis://` and `rediss://`.

---

## 3. Render

1. **New Web Service** → Connect GitHub → select `ai-router`
2. **Runtime**: Docker (Render auto-detects `docker/Dockerfile`)
3. **Add Redis** — New → Redis → copy the Internal Redis URL
4. **Environment variables**:

| Variable | Value |
|----------|-------|
| `ROUTER_API_KEY` | your secret key |
| `OPENAI_API_KEY` | sk-... |
| `ANTHROPIC_API_KEY` | sk-ant-... |
| `GOOGLE_API_KEY` | AIza... |
| `REDIS_URL` | (from Render Redis add-on) |

5. **Deploy** and verify at the Render-provided URL.

> **Free tier note:** Render free instances sleep after 15 minutes of inactivity. The first request after sleep takes ~30s. Use a paid plan or a keep-alive ping service for production.

---

## 4. Fly.io

```bash
# Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly auth login

# Launch app (creates fly.toml automatically)
fly launch --dockerfile docker/Dockerfile --no-deploy

# Create managed Redis (Upstash)
fly redis create

# Set secrets
fly secrets set \
  ROUTER_API_KEY=your-secret-key \
  OPENAI_API_KEY=sk-... \
  ANTHROPIC_API_KEY=sk-ant-... \
  GOOGLE_API_KEY=AIza... \
  REDIS_URL=$(fly redis status <redis-name> --json | jq -r '.public_url')

# Deploy
fly deploy

# Verify
curl https://your-app.fly.dev/health
```

---

## 5. VPS (Ubuntu/Debian)

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone repo
git clone https://github.com/fabianprogrammer123/ai-router
cd ai-router

# Configure
cp .env.example .env
nano .env   # fill in your keys

# Start
docker compose up -d

# View logs
docker compose logs -f ai-router
```

**Run as systemd service** (auto-start on boot):

```bash
cat > /etc/systemd/system/ai-router.service <<EOF
[Unit]
Description=AI Router
After=docker.service
Requires=docker.service

[Service]
WorkingDirectory=/opt/ai-router
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now ai-router
```

---

## 6. Scaling

With Redis enabled, multiple router instances share state (rate limits, circuit breakers, async job queue):

```bash
# Run 2 instances behind nginx
docker compose up -d --scale ai-router=2

# Add nginx service to docker-compose.yml (or run separately):
#   image: nginx:alpine
#   volumes: [./docker/nginx.conf:/etc/nginx/conf.d/default.conf]
#   ports: ["80:80"]
#   depends_on: [ai-router]
```

See `docker/nginx.conf` for the upstream configuration.

---

## 7. Verification

```bash
# Health check
curl http://localhost:3000/health
# → {"status":"ok"}

# Chat completion
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-router-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Say one word"}]}'

# Check which provider served the request (in response headers):
curl -sI -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-router-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i x-ai-router
# x-ai-router-provider: openai
# x-ai-router-model: gpt-4o

# Provider status (live rate limit + circuit breaker state)
curl http://localhost:3000/v1/providers/status
```

---

## 8. Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ROUTER_API_KEY` | ✅ | — | Key your apps use to authenticate |
| `OPENAI_API_KEY` | * | — | OpenAI key (\*at least one required) |
| `ANTHROPIC_API_KEY` | * | — | Anthropic key |
| `GOOGLE_API_KEY` | * | — | Google AI key |
| `REDIS_URL` | | — | Redis connection URL (enables persistence) |
| `PORT` | | `3000` | Server port |
| `HOST` | | `0.0.0.0` | Server bind address |
| `LOG_LEVEL` | | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace` |
| `PROVIDER_PRIORITY` | | `openai,anthropic,google` | Fallback order |
| `DEFAULT_ROUTING_STRATEGY` | | `fallback` | `fallback`, `round-robin`, or `latency` |
| `QUEUE_MAX_SIZE` | | `100` | Max concurrent queued requests |
| `QUEUE_TIMEOUT_MS` | | `30000` | Total queue timeout per request |
| `QUEUE_ASYNC_THRESHOLD_MS` | | `5000` | Threshold for 202 async response |
| `CB_FAILURE_THRESHOLD` | | `5` | 5xx failures before opening circuit |
| `CB_COOLDOWN_MS` | | `60000` | Circuit open cooldown (ms) |
| `RATE_LIMIT_LOW_REQUESTS_THRESHOLD` | | `5` | Skip provider when remaining < this |

---

## 9. Response Headers

Every successful response includes:

| Header | Example | Description |
|--------|---------|-------------|
| `x-ai-router-provider` | `openai` | Which provider actually served the request |
| `x-ai-router-model` | `gpt-4o` | Which model was used (may differ if fallback occurred) |

Use these to detect when fallback routing was triggered (e.g., show a debug badge in your UI).
