import { useEffect, useState } from 'react';
import type { AppRuntime } from '@/shared/hooks/useAppRuntime';

/**
 * Which host the Quick chat / Autopilot dialog targets.
 *
 * An empty dialog opens on the host the document (the active pane) is on.
 * After that only the picker moves the target: focusing another pane behind
 * the dialog does not, and a draft keeps the host it was written for across
 * reopens — its folder and attachments live there, and the same prompt on
 * another host would run in an unrelated working tree.
 */
export function useQuickChatHostSelection({
  visible,
  runtime,
  routeHostId,
  firstOnlineHostId,
  hasDraft,
}: {
  visible: boolean;
  runtime: AppRuntime;
  /** The document's host (`null` = this machine, or no host on remote). */
  routeHostId: string | null;
  firstOnlineHostId: string | null;
  hasDraft: boolean;
}) {
  const [selectedHostId, setSelectedHostId] = useState<string | null>(
    routeHostId
  );
  // Retargeted while rendering the open, not in an effect after it: an effect
  // would first commit the previous host's panel, which sends that host a
  // round of requests for a dialog that was never about it.
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    const justOpened = visible;
    // The remote web's default host directly, not via `null`: a `null`
    // commit would re-key the host draft and drop its folder and model.
    if (justOpened && !hasDraft) {
      setSelectedHostId(
        routeHostId ?? (runtime === 'remote' ? firstOnlineHostId : null)
      );
    }
  }

  // The remote web has no "this machine", so with nothing chosen yet the
  // first online host is the default. A chosen host is never replaced.
  useEffect(() => {
    if (!visible || runtime !== 'remote') return;
    if (selectedHostId === null && firstOnlineHostId) {
      setSelectedHostId(firstOnlineHostId);
    }
  }, [visible, runtime, selectedHostId, firstOnlineHostId]);

  return [selectedHostId, setSelectedHostId] as const;
}
