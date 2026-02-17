# AI Router — Benchmark Assessment

## Context

During Phase 1, a 5-round benchmark was run comparing:
- **Path A**: App → AI Router → OpenAI
- **Path B**: App → OpenAI directly
- **Path C**: App → AI Router → Anthropic
- **Path D**: App → Anthropic directly

---

## What Went Right

- Confirmed both paths work end-to-end under load
- Fallback routing was demonstrated live (when OpenAI was simulated as rate-limited)
- 10 parallel requests all succeeded — router handled concurrency without queuing failures
- Confirmed routing overhead is not catastrophic (sub-100ms at worst in all rounds)

---

## Statistical Weaknesses

**Sample size is too small to draw conclusions:**

| Issue | Why It Matters |
|-------|----------------|
| n=5 rounds, ~20 data points per path | You need n≥30 for a t-test, n≥100 to reliably estimate p95 |
| "Router→OpenAI was 89ms faster than Direct" | With n=5, this is almost certainly sampling noise. The 95% CI completely overlaps. |
| All 4 paths ran in parallel each round | They competed for the same network bandwidth and connection pool, inflating all latencies |

---

## Uncontrolled Confounders

| Confounder | Effect |
|------------|--------|
| **Time of day** | OpenAI API latency varies 2–3× between peak and off-peak hours |
| **Tiny prompt** ("one word") | Best case for all providers; real 1k-token prompts show substantially different patterns |
| **Round 1 warm-up** | First request in each path pays TLS handshake + TCP slow-start cost (~50–150ms extra); not separated from results |
| **Geographic routing** | Provider API endpoints are regional; requests may hit different PoPs between rounds, adding variance |
| **Connection pooling** | `undici` reuses connections; round 1 penalty isn't amortized correctly |

---

## What the Benchmark CAN Claim

- Routing overhead is not catastrophic (sub-100ms in all observed cases)
- Fallback is seamless — clients receive a valid response regardless of which provider serves it
- 10 concurrent requests succeed without triggering the queue
- The router does not add unbounded latency

## What the Benchmark CANNOT Claim

- Any specific latency advantage of either path (router vs. direct)
- p95 or p99 tail latency behaviour
- Performance under sustained load (requests per second, throughput)
- Behaviour under realistic token counts

---

## How to Run a Rigorous Benchmark

Use [`k6`](https://k6.io) or [`autocannon`](https://github.com/mcollina/autocannon) for statistically valid results:

### k6 example

```javascript
// benchmark.js
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  scenarios: {
    router: {
      executor: 'constant-vus',
      vus: 1,
      duration: '5m',
      env: { TARGET: 'http://localhost:3000/v1/chat/completions' },
    },
  },
  thresholds: {
    http_req_duration: ['p95<2000'],
  },
};

const BODY = JSON.stringify({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'In exactly 50 words, explain quantum entanglement.' }],
});

export default function () {
  http.post(__ENV['TARGET'], BODY, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV['ROUTER_API_KEY']}`,
    },
  });
  sleep(0.5);
}
```

```bash
# Warmup (discarded)
k6 run --iterations 10 benchmark.js

# Actual measurement
k6 run --iterations 200 benchmark.js
```

### What to report

| Metric | Why |
|--------|-----|
| p50 (median) | Typical user experience |
| p75 | Upper-mid experience |
| p95 | Near-worst-case for most users |
| p99 | Tail latency — reveals outliers |
| NOT average | Easily skewed by outliers |

### Statistical significance

Use Welch's t-test (unequal variance) to compare two paths:

```python
from scipy import stats
import numpy as np

router_latencies = [...]   # your measurements
direct_latencies = [...]

t_stat, p_value = stats.ttest_ind(router_latencies, direct_latencies, equal_var=False)
print(f"p-value: {p_value:.4f} (significant if < 0.05)")
```

### Recommended protocol

1. Run at the same time of day on separate days (3 days minimum)
2. Use a fixed prompt with a controlled token count (e.g., exactly 100 input tokens)
3. Sequential execution — one path at a time (no cross-path interference)
4. Discard the first 10 iterations of each run (warm-up)
5. Aim for n≥200 per path per measurement session
6. Report p50/p75/p95/p99, not averages
