import { type Provider, type Capability } from './provider.js';
import { type ProviderResponse } from './request.js';

export type RoutingStrategy = 'fallback' | 'round-robin' | 'latency';

export interface FallbackChainEntry {
  provider: Provider;
  model: string;
}

export interface RouterResult {
  /** The provider that ultimately served the request */
  provider: Provider;
  /** The model used at the serving provider */
  model: string;
  /** The original model requested by the client */
  requestedModel: string;
  /** The raw provider response */
  response: ProviderResponse;
}

export interface QueuedJobSync {
  mode: 'sync';
  result: RouterResult;
}

export interface QueuedJobAsync {
  mode: 'async';
  jobId: string;
  estimatedWaitMs: number;
}

export type RouterExecuteResult = RouterResult | QueuedJobAsync;

export interface QueueJob {
  id: string;
  createdAt: number;
  timeoutAt: number;
  estimatedWaitMs: number;
  capability: Capability;
  requestedModel: string;
  body?: unknown;
  status: 'pending' | 'processing' | 'done' | 'error' | 'expired';
  resolve?: ((result: RouterResult) => void) | undefined;
  reject?: ((err: Error) => void) | undefined;
  result?: RouterResult;
  error?: Error;
}

export interface ProviderStatus {
  provider: Provider;
  circuitState: 'closed' | 'open' | 'half-open';
  coolingDown: boolean;
  cooldownUntilMs: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequestsAt: number | null;
  resetTokensAt: number | null;
}
