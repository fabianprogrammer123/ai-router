import { type Capability } from '../types/provider.js';
import { type ProviderResponse } from '../types/request.js';

/**
 * Abstract interface for all provider adapters.
 * Each adapter translates between the OpenAI wire format and the provider's native API.
 */
export interface ProviderAdapter {
  /**
   * Execute a request against this provider.
   *
   * @param capability - The type of request (chat, images, embeddings)
   * @param requestedModel - The original model name from the client
   * @param providerModel - The provider-specific model name to use
   * @param signal - AbortSignal for request cancellation
   * @param body - The raw request body (in OpenAI format)
   */
  call(
    capability: Capability,
    requestedModel: string,
    providerModel: string,
    signal: AbortSignal,
    body?: unknown
  ): Promise<ProviderResponse>;
}

/**
 * Base class with shared utilities for provider adapters
 */
export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract call(
    capability: Capability,
    requestedModel: string,
    providerModel: string,
    signal: AbortSignal,
    body?: unknown
  ): Promise<ProviderResponse>;

  protected buildId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  protected currentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
  }
}
