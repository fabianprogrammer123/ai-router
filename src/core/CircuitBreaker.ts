import { type Provider } from '../types/provider.js';

type CircuitState = 'closed' | 'open' | 'half-open';

interface ProviderCircuit {
  state: CircuitState;
  failureCount: number;
  openedAt: number; // epoch ms; 0 = not open
  halfOpenTestInFlight: boolean;
}

export class CircuitBreaker {
  private readonly circuits = new Map<Provider, ProviderCircuit>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(failureThreshold: number, cooldownMs: number) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
  }

  private getOrCreate(provider: Provider): ProviderCircuit {
    let c = this.circuits.get(provider);
    if (!c) {
      c = {
        state: 'closed',
        failureCount: 0,
        openedAt: 0,
        halfOpenTestInFlight: false,
      };
      this.circuits.set(provider, c);
    }
    return c;
  }

  /**
   * Returns true if the circuit allows traffic to this provider.
   * Transitions open → half-open automatically after cooldown.
   */
  isAvailable(provider: Provider): boolean {
    const c = this.getOrCreate(provider);

    switch (c.state) {
      case 'closed':
        return true;

      case 'open': {
        const elapsed = Date.now() - c.openedAt;
        if (elapsed >= this.cooldownMs) {
          // Transition to half-open, allow exactly one test request
          c.state = 'half-open';
          c.halfOpenTestInFlight = true; // mark in-flight immediately
          return true;
        }
        return false;
      }

      case 'half-open':
        // Only allow if no test request is currently in-flight
        if (!c.halfOpenTestInFlight) {
          c.halfOpenTestInFlight = true;
          return true;
        }
        return false;
    }
  }

  /**
   * Record a successful response. Resets failure count; closes circuit if half-open.
   */
  recordSuccess(provider: Provider): void {
    const c = this.getOrCreate(provider);
    c.failureCount = 0;
    c.halfOpenTestInFlight = false;
    if (c.state !== 'closed') {
      c.state = 'closed';
      c.openedAt = 0;
    }
  }

  /**
   * Record a failure response.
   * CRITICAL: 429 (rate-limit) does NOT count as a circuit failure.
   * Only 5xx errors open/keep the circuit open.
   */
  recordFailure(provider: Provider, statusCode: number): void {
    // Rate limit events are NOT infrastructure failures
    if (statusCode === 429) return;

    // Only track 5xx server errors
    if (statusCode < 500) return;

    const c = this.getOrCreate(provider);

    if (c.state === 'half-open') {
      // Test request failed — reopen circuit
      c.state = 'open';
      c.openedAt = Date.now();
      c.halfOpenTestInFlight = false;
      return;
    }

    c.failureCount++;
    if (c.failureCount >= this.failureThreshold) {
      c.state = 'open';
      c.openedAt = Date.now();
    }
  }

  /**
   * Get circuit state for a provider (for status endpoint)
   */
  getState(provider: Provider): CircuitState {
    return this.getOrCreate(provider).state;
  }

  /**
   * Get all circuit states
   */
  getAllStates(): Map<Provider, CircuitState> {
    const result = new Map<Provider, CircuitState>();
    for (const [provider, circuit] of this.circuits.entries()) {
      result.set(provider, circuit.state);
    }
    return result;
  }
}
