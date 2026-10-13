import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  WorkspaceStatusStrip,
  type WorkspaceStatusState,
} from '@vibe/ui/components/WorkspaceStatusStrip';
import { formatRelativeElapsed } from '@vibe/ui/components/WorkspaceSummary';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { statusFirstSentence, statusParagraphs } from '@/shared/lib/statusNote';
import { useLiveStatus } from '../model/hooks/useLiveStatus';
import { ArtifactPreviewDialog, useExecutionArtifacts } from './ArtifactCards';
import { findSegmentArtifact } from './artifact-preview';

const OPEN_KEY = 'workspace-status-strip';

/**
 * Feeds the strip from two sources: the block streaming in the latest
 * assistant message while the workspace runs, otherwise the summary stored on
 * the workspace row (which the workspace stream keeps live).
 */
export function WorkspaceStatusStripContainer({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string | undefined;
}) {
  const hostId = useHostId();
  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();
  const row = useMemo(
    () =>
      activeWorkspaces.find((workspace) => workspace.id === workspaceId) ??
      archivedWorkspaces.find((workspace) => workspace.id === workspaceId),
    [activeWorkspaces, archivedWorkspaces, workspaceId]
  );
  const { draft, history } = useLiveStatus();
  const live = draft && row?.isRunning ? draft : undefined;
  const current = live?.text ?? row?.statusNote;

  const items = useMemo(() => {
    const past = history.filter((item) => item.text !== current);
    return current
      ? [{ text: current, at: row?.statusUpdatedAt ?? null }, ...past]
      : past;
  }, [current, history, row?.statusUpdatedAt]);

  const [view, setView] = useState(0);
  // A fresh summary always returns the reader to the latest one.
  useEffect(() => setView(0), [current]);
  const viewed = items[Math.min(view, items.length - 1)];
  const paragraphs = useMemo(
    () => (viewed ? statusParagraphs(viewed.text) : []),
    [viewed]
  );

  const open = useUiPreferencesStore((s) => s.expanded[OPEN_KEY] ?? false);
  const toggleExpanded = useUiPreferencesStore((s) => s.toggleExpanded);
  const onToggle = useCallback(
    () => toggleExpanded(OPEN_KEY, false),
    [toggleExpanded]
  );

  const processId = draft?.executionProcessId;
  const artifacts = useExecutionArtifacts(
    processId ?? '',
    workspaceId,
    sessionId,
    !!processId && !!sessionId
  );
  const onOpenLink = useCallback(
    (target: string, artifact: boolean) => {
      if (artifact && processId && sessionId) {
        const found = findSegmentArtifact(
          { kind: 'file', raw: '', path: target },
          artifacts.data?.artifacts ?? [],
          []
        );
        if (found) {
          void ArtifactPreviewDialog.show({
            artifact: found,
            scope: { processId, workspaceId, sessionId, hostId },
          });
          return;
        }
      }
      // ponytail: a path the latest process never attached is left inert;
      // resolve against earlier processes if summaries start citing old files.
      if (/^https?:\/\//.test(target)) void openExternalUrl(target);
    },
    [artifacts.data, processId, sessionId, workspaceId, hostId]
  );

  if (!viewed) return null;

  const state: WorkspaceStatusState =
    row?.isRunning && row.hasPendingApproval
      ? 'pending'
      : row?.isRunning && !row.isWaiting
        ? 'running'
        : row?.latestProcessStatus === 'failed' ||
            row?.latestProcessStatus === 'killed'
          ? 'failed'
          : 'idle';
  const isPast = view > 0 && view < items.length;
  const timeLabel = isPast
    ? viewed.at
      ? new Date(viewed.at).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''
    : live
      ? formatRelativeElapsed(new Date().toISOString())
      : viewed.at
        ? formatRelativeElapsed(viewed.at)
        : '';

  return (
    <WorkspaceStatusStrip
      headline={statusFirstSentence(viewed.text)}
      paragraphs={paragraphs}
      state={state}
      streaming={!isPast && !!live && !live.closed}
      isPast={isPast}
      timeLabel={timeLabel}
      open={open}
      onToggle={onToggle}
      canPrev={view < items.length - 1}
      canNext={view > 0}
      onPrev={() => setView((v) => Math.min(v + 1, items.length - 1))}
      onNext={() => setView((v) => Math.max(v - 1, 0))}
      onOpenLink={onOpenLink}
    />
  );
}
