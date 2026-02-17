import { randomUUID } from 'crypto';
import { type Capability } from '../types/provider.js';
import { type RouterResult } from '../types/routing.js';
import { RequestQueue } from './RequestQueue.js';
import { Redis } from './redis.js';
import { sleep } from '../utils/retry.js';

const PENDING_KEY = 'ai-router:queue:pending';
const JOB_KEY = (id: string) => `ai-router:queue:job:${id}`;
const RESULT_KEY = (id: string) => `ai-router:queue:result:${id}`;
const RESULT_TTL_S = 3600;

interface RedisJobData {
  id: string;
  capability: string;
  requestedModel: string;
  body: string; // JSON-encoded or empty string
  createdAt: string;
  timeoutAt: string;
  estimatedWaitMs: string;
}

interface RedisJobResult {
  status: 'done' | 'error' | 'expired';
  result?: RouterResult;
  error?: string;
}

/**
 * Request queue backed by Redis for async job persistence across restarts and instances.
 *
 * Sync jobs (estimatedWaitMs ≤ asyncThresholdMs): always in-memory — Promise callbacks
 * cannot cross process boundaries, so this path is unchanged.
 *
 * Async jobs (estimatedWaitMs > asyncThresholdMs): stored in Redis.
 * - Any instance can drain the Redis pending list (LPOP is atomic → no double-processing).
 * - Results are stored in Redis so any instance can serve the poll response.
 */
export class RequestQueueRedis extends RequestQueue {
  private readonly redis: Redis;

  constructor(maxSize: number, timeoutMs: number, asyncThresholdMs: number, redis: Redis) {
    super(maxSize, timeoutMs, asyncThresholdMs);
    this.redis = redis;
  }

  override async enqueue(
    capability: Capability,
    requestedModel: string,
    estimatedWaitMs: number,
    body?: unknown
  ): Promise<
    | { mode: 'sync'; result: RouterResult }
    | { mode: 'async'; jobId: string; estimatedWaitMs: number }
  > {
    // Sync path: promise-based inline wait — stays in-memory
    if (estimatedWaitMs <= this.asyncThresholdMs) {
      return super.enqueue(capability, requestedModel, estimatedWaitMs, body);
    }

    // Async path: store in Redis
    if (this.jobs.size >= this.maxSize) {
      throw new Error(`Request queue is full (${this.maxSize} max). Try again later.`);
    }

    const jobId = randomUUID();
    const now = Date.now();
    const jobData: RedisJobData = {
      id: jobId,
      capability,
      requestedModel,
      body: body ? JSON.stringify(body) : '',
      createdAt: String(now),
      timeoutAt: String(now + this.timeoutMs),
      estimatedWaitMs: String(estimatedWaitMs),
    };

    try {
      await Promise.all([
        this.redis.rpush(PENDING_KEY, jobId),
        this.redis.hset(JOB_KEY(jobId), jobData as unknown as Record<string, string>),
      ]);
    } catch {
      // Redis unavailable — degrade to in-memory async (same instance only)
      return super.enqueue(capability, requestedModel, estimatedWaitMs, body);
    }

    this.scheduleProcessing(estimatedWaitMs);
    return { mode: 'async', jobId, estimatedWaitMs };
  }

  override async poll(jobId: string): Promise<{
    status: 'pending' | 'done' | 'error' | 'expired' | 'not_found';
    result?: RouterResult;
    error?: string;
  }> {
    // Check in-memory first (covers sync jobs being processed locally)
    const local = await super.poll(jobId);
    if (local.status !== 'not_found') return local;

    // Check Redis for async jobs (from this or another instance)
    try {
      const raw = await this.redis.get(RESULT_KEY(jobId));
      if (raw) {
        return JSON.parse(raw) as RedisJobResult;
      }

      // No result yet — check if job data still exists (still pending/processing)
      const jobExists = await this.redis.exists(JOB_KEY(jobId));
      if (jobExists) return { status: 'pending' };

      return { status: 'not_found' };
    } catch {
      return { status: 'not_found' };
    }
  }

  protected override async drain(): Promise<void> {
    // Process in-memory sync jobs (base class handles these)
    await super.drain();

    // Process one async job from the Redis pending list
    if (!this.drainFn) return;

    let jobId: string | null;
    try {
      jobId = await this.redis.lpop(PENDING_KEY);
    } catch {
      return; // Redis unavailable
    }

    if (!jobId) return;

    // Fetch job data
    let raw: Record<string, string> | null;
    try {
      raw = await this.redis.hgetall(JOB_KEY(jobId));
    } catch {
      return;
    }

    if (!raw || !raw['capability']) return;

    const timeoutAt = parseInt(raw['timeoutAt'] ?? '0', 10);
    if (Date.now() > timeoutAt) {
      const expired: RedisJobResult = { status: 'expired', error: 'Request timed out while queued' };
      await this.redis.set(RESULT_KEY(jobId), JSON.stringify(expired), 'EX', RESULT_TTL_S).catch(() => {});
      await this.redis.del(JOB_KEY(jobId)).catch(() => {});
      return;
    }

    const controller = new AbortController();
    const remaining = timeoutAt - Date.now();
    const timeoutTimer = setTimeout(() => controller.abort(), remaining);

    try {
      const capability = raw['capability'] as Capability;
      const requestedModel = raw['requestedModel'] ?? '';
      const body = raw['body'] ? (JSON.parse(raw['body']) as unknown) : undefined;

      const result = await this.drainFn(jobId, capability, requestedModel, controller.signal, body);
      clearTimeout(timeoutTimer);

      const done: RedisJobResult = { status: 'done', result };
      await this.redis.set(RESULT_KEY(jobId), JSON.stringify(done), 'EX', RESULT_TTL_S).catch(() => {});
    } catch (err) {
      clearTimeout(timeoutTimer);
      const error = err instanceof Error ? err.message : String(err);
      const failed: RedisJobResult = { status: 'error', error };
      await this.redis.set(RESULT_KEY(jobId), JSON.stringify(failed), 'EX', RESULT_TTL_S).catch(() => {});
    } finally {
      await this.redis.del(JOB_KEY(jobId)).catch(() => {});
    }

    // Small pause to avoid thundering herd, then drain again if more jobs
    await sleep(50);
    const remaining2 = await this.redis.llen(PENDING_KEY).catch(() => 0);
    if (remaining2 > 0) {
      this.scheduleProcessing(0);
    }
  }

  /**
   * On startup: re-enqueue any jobs that were pending when the previous instance died.
   */
  async loadPendingFromRedis(): Promise<void> {
    try {
      const count = await this.redis.llen(PENDING_KEY);
      if (count > 0) {
        // Jobs are already in the Redis list — schedule a drain pass
        this.scheduleProcessing(0);
      }
    } catch {
      // Redis unavailable
    }
  }

  override get size(): number {
    // Returns local (sync) job count; Redis async jobs are drained separately
    return this.jobs.size;
  }
}
