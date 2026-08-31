import type { ExecutorConfig } from 'shared/types';

/**
 * Mounted chat composers publish their resolved agent selection here so
 * non-React callers (command palette actions) can start reviews with the same
 * config the composer shows, instead of the backend's last-executed fallback.
 */
const configsBySession = new Map<string, ExecutorConfig>();

export function publishChatExecutorConfig(
  sessionId: string,
  config: ExecutorConfig
): void {
  configsBySession.set(sessionId, config);
}

/** Compare-and-clear: a stale unmount must not wipe a newer registration. */
export function unpublishChatExecutorConfig(
  sessionId: string,
  config: ExecutorConfig
): void {
  if (configsBySession.get(sessionId) === config) {
    configsBySession.delete(sessionId);
  }
}

export function getChatExecutorConfig(
  sessionId: string | null | undefined
): ExecutorConfig | null {
  return (sessionId && configsBySession.get(sessionId)) || null;
}
