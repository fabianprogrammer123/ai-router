import { randomUUID } from 'crypto';
import { type QueueJob } from '../types/routing.js';
import { type Capability } from '../types/provider.js';
import { type RouterResult } from '../types/routing.js';
import { sleep } from '../utils/retry.js';

export type DrainFunction = (jobId: string, capability: Capability, requestedModel: string, signal: AbortSignal, body?: unknown) => Promise<RouterResult>;

export class RequestQueue {
  protected readonly jobs = new Map<string, QueueJob>();
  protected readonly maxSize: number;
  protected readonly timeoutMs: number;
  protected readonly asyncThresholdMs: number;
  protected drainTimer: ReturnType<typeof setTimeout> | null = null;
  protected drainFn: DrainFunction | null = null;

  constructor(maxSize: number, timeoutMs: number, asyncThresholdMs: number) {
    this.maxSize = maxSize;
    this.timeoutMs = timeoutMs;
    this.asyncThresholdMs = asyncThresholdMs;
  }

  /**
   * Register the function called when the queue drains.
   * Avoids circular dependency between Router and RequestQueue.
   */
  setDrainFunction(fn: DrainFunction): void {
    this.drainFn = fn;
  }

  /**
   * Enqueue a request.
   * - If estimatedWaitMs < asyncThresholdMs: blocks inline and returns result (200)
   * - Otherwise: stores job, returns async descriptor (202)
   */
  async enqueue(
    capability: Capability,
    requestedModel: string,
    estimatedWaitMs: number,
    body?: unknown
  ): Promise<{ mode: 'sync'; result: RouterResult } | { mode: 'async'; jobId: string; estimatedWaitMs: number }> {
    if (this.jobs.size >= this.maxSize) {
      throw new Error(`Request queue is full (${this.maxSize} max). Try again later.`);
    }

    const jobId = randomUUID();
    const now = Date.now();
    const job: QueueJob = {
      id: jobId,
      createdAt: now,
      timeoutAt: now + this.timeoutMs,
      estimatedWaitMs,
      capability,
      requestedModel,
      body,
      status: 'pending',
    };

    if (estimatedWaitMs <= this.asyncThresholdMs) {
      // Inline wait — block until the provider becomes available
      return new Promise<RouterResult>((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
        this.jobs.set(jobId, job);
        this.scheduleProcessing(estimatedWaitMs);
      }).then((result) => ({ mode: 'sync' as const, result }));
    }

    // Async mode — return immediately with a job ID
    this.jobs.set(jobId, job);
    this.scheduleProcessing(estimatedWaitMs);

    return { mode: 'async', jobId, estimatedWaitMs };
  }

  /**
   * Poll for an async job result
   */
  async poll(jobId: string): Promise<{
    status: 'pending' | 'done' | 'error' | 'expired' | 'not_found';
    result?: RouterResult;
    error?: string;
  }> {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 'not_found' };

    switch (job.status) {
      case 'done':
        if (job.result) return { status: 'done', result: job.result };
        return { status: 'error', error: 'Result missing' };
      case 'error':
        return { status: 'error', error: job.error?.message ?? 'Unknown error' };
      case 'expired':
        return { status: 'expired', error: 'Request timed out in queue' };
      default:
        return { status: 'pending' };
    }
  }

  /**
   * Schedule a drain pass after delayMs (debounced)
   */
  scheduleProcessing(delayMs: number): void {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drain();
    }, Math.max(0, delayMs));
  }

  /**
   * Process all pending jobs FIFO, skipping expired ones
   */
  protected async drain(): Promise<void> {
    if (!this.drainFn) return;

    const pendingJobs = [...this.jobs.values()]
      .filter((j) => j.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const job of pendingJobs) {
      // Check expiry
      if (Date.now() > job.timeoutAt) {
        job.status = 'expired';
        job.reject?.(new Error('Request timed out while queued'));
        this.jobs.delete(job.id);
        continue;
      }

      job.status = 'processing';

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), job.timeoutAt - Date.now());

        const result = await this.drainFn(
          job.id,
          job.capability,
          job.requestedModel,
          controller.signal,
          job.body
        );

        clearTimeout(timeoutId);
        job.status = 'done';
        job.result = result;
        job.resolve?.(result);

        // Keep async results for polling (clean up after TTL)
        if (!job.resolve) {
          setTimeout(() => this.jobs.delete(job.id), 60_000);
        } else {
          this.jobs.delete(job.id);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        job.status = 'error';
        job.error = error;
        job.reject?.(error);

        if (!job.reject) {
          setTimeout(() => this.jobs.delete(job.id), 60_000);
        } else {
          this.jobs.delete(job.id);
        }
      }

      // Small pause between jobs to avoid thundering herd
      await sleep(50);
    }
  }

  get size(): number {
    return this.jobs.size;
  }
}
