import type { ExecutorConfig } from 'shared/types';

/**
 * Mounted chat composers publish their resolved agent selection here so
 * non-React callers (command palette actions) can start reviews with the same
 * config the composer shows, instead of the backend's last-executed fallback.
 *
 * Entries deliberately outlive the composer: the chat panel unmounts while its
 * session stays selected (narrow-pane changes view, hidden left panel), and the
 * palette must still honor the selection there. The composer is the only
 * writer and republishes on every change, so an entry always equals the last
 * selection shown for that session in this tab.
 */
const configsBySession = new Map<string, ExecutorConfig>();

export function publishChatExecutorConfig(
  sessionId: string,
  config: ExecutorConfig
): void {
  configsBySession.set(sessionId, config);
}

export function getChatExecutorConfig(
  sessionId: string | null | undefined
): ExecutorConfig | null {
  return (sessionId && configsBySession.get(sessionId)) || null;
}
