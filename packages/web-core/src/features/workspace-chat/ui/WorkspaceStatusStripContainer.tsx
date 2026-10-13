import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ExecutionProcessStatus } from 'shared/types';
import {
  WorkspaceStatusStrip,
  type WorkspaceStatusState,
} from '@vibe/ui/components/WorkspaceStatusStrip';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useChangesViewActions } from '@/shared/hooks/useChangesView';
import { ExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { formatClock, formatRelativeTime } from '@/shared/lib/date';
import { statusFirstSentence, statusParagraphs } from '@/shared/lib/statusNote';
import { useLiveStatus } from '../model/hooks/useLiveStatus';
import { ArtifactPreviewDialog, useExecutionArtifacts } from './ArtifactCards';
import { findSegmentArtifact } from './artifact-preview';

const OPEN_KEY = 'workspace-status-strip';

// ts-rs types these as Date; the wire carries ISO strings.
const iso = (value: unknown) =>
  value ? new Date(value as string).toISOString() : null;

/**
 * Feeds the strip from two sources: the block streaming in the running
 * process's latest assistant message, otherwise the summary stored on the
 * workspace row (which the workspace stream keeps live).
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
  // Optional: pages outside a pane scope fall back to the row's running flag.
  const processes = useContext(ExecutionProcessesContext);
  const processById = processes?.executionProcessesByIdAll;
  const draftIsLive = draft
    ? processById
      ? processById[draft.executionProcessId]?.status ===
        ExecutionProcessStatus.running
      : !!row?.isRunning
    : false;
  const live = draftIsLive ? draft : undefined;
  const streaming = !!live && !live.closed;
  const current = live?.text ?? row?.statusNote;

  const processTime = useCallback(
    (id: string) => {
      const process = processById?.[id];
      return iso(process?.completed_at ?? process?.started_at);
    },
    [processById]
  );
  // A draft the server has not stored yet has no timestamp of its own.
  const currentAt =
    live && live.text !== row?.statusNote
      ? null
      : (row?.statusUpdatedAt ?? null);
  const items = useMemo(() => {
    const past = history
      .filter((item) => item.text !== current)
      .map((item) => ({
        text: item.text,
        at: processTime(item.executionProcessId),
      }));
    return current ? [{ text: current, at: currentAt }, ...past] : past;
  }, [current, currentAt, history, processTime]);

  const [view, setView] = useState(0);
  // A newly stored summary returns the reader to the latest one; tokens of a
  // streaming block do not yank them away from an earlier summary.
  useEffect(() => {
    if (!streaming) setView(0);
  }, [current, streaming]);
  const viewed = items[Math.min(view, items.length - 1)];
  const paragraphs = useMemo(
    () => (viewed ? statusParagraphs(viewed.text) : []),
    [viewed]
  );
  // Relative labels ("2m ago") drift without a re-render; tick them along.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const open = useUiPreferencesStore((s) => s.expanded[OPEN_KEY] ?? false);
  const toggleExpanded = useUiPreferencesStore((s) => s.toggleExpanded);
  const onToggle = useCallback(
    () => toggleExpanded(OPEN_KEY, false),
    [toggleExpanded]
  );

  // Attachments are looked up on the process that wrote the block, else the
  // session's latest process; a stored note from an older session falls
  // through to the file viewer.
  const processId =
    draft?.executionProcessId ?? processes?.executionProcessesAll.at(-1)?.id;
  const artifacts = useExecutionArtifacts(
    processId ?? '',
    workspaceId,
    sessionId,
    !!processId && !!sessionId
  );
  const { viewFileInChanges } = useChangesViewActions();
  const onOpenLink = useCallback(
    (target: string, artifact: boolean) => {
      if (/^https?:\/\//.test(target)) {
        void openExternalUrl(target);
        return;
      }
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
      viewFileInChanges(target.replace(/^(\.\/)+/, ''));
    },
    [
      artifacts.data,
      processId,
      sessionId,
      workspaceId,
      hostId,
      viewFileInChanges,
    ]
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
      ? formatClock(viewed.at)
      : ''
    : viewed.at
      ? formatRelativeTime(viewed.at)
      : live
        ? formatRelativeTime(new Date().toISOString())
        : '';

  return (
    <WorkspaceStatusStrip
      headline={statusFirstSentence(viewed.text)}
      paragraphs={paragraphs}
      state={state}
      streaming={!isPast && streaming}
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
