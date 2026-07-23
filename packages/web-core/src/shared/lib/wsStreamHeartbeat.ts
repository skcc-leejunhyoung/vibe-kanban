// The server emits execution-process heartbeats every 30 seconds. Waiting for
// more than two missed heartbeats avoids reconnecting healthy, quiet streams
// while still recovering a foreground tab whose socket is silently wedged.
export const EXECUTION_PROCESS_STREAM_SILENCE_TIMEOUT_MS = 75_000;
const WEBSOCKET_OPEN = 1;

export interface StreamSilenceDecisionInput {
  enabled: boolean;
  hasEndpoint: boolean;
  finished: boolean;
  isCurrentSocket: boolean;
  readyState: number;
}

export function shouldReconnectForStreamSilence(
  input: StreamSilenceDecisionInput
): boolean {
  return (
    input.enabled &&
    input.hasEndpoint &&
    !input.finished &&
    input.isCurrentSocket &&
    input.readyState === WEBSOCKET_OPEN
  );
}
