export const WS_FAILURE_THRESHOLD = 6;

/**
 * Tracks whether the current connection generation has received a server
 * message. A previous connection to the same endpoint must not make a later,
 * silent connection look healthy.
 */
export class WsConnectionHealth {
  private endpoint: string | undefined;
  private generation = 0;
  private liveGeneration: number | undefined;
  private consecutiveFailures = 0;

  startConnection(endpoint: string): number {
    if (this.endpoint !== endpoint) {
      this.endpoint = endpoint;
      this.consecutiveFailures = 0;
    }

    this.generation += 1;
    return this.generation;
  }

  reset(): void {
    this.endpoint = undefined;
    this.liveGeneration = undefined;
    this.consecutiveFailures = 0;
  }

  markLive(generation: number): void {
    if (generation !== this.generation) return;
    this.liveGeneration = generation;
    this.consecutiveFailures = 0;
  }

  recordFailure(generation: number): boolean {
    if (generation !== this.generation) return false;

    this.consecutiveFailures += 1;
    return (
      this.liveGeneration !== generation &&
      this.consecutiveFailures > WS_FAILURE_THRESHOLD
    );
  }

  failureCount(): number {
    return this.consecutiveFailures;
  }
}
