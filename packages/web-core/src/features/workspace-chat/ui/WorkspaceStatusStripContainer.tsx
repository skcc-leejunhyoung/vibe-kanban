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
import {
  PERSIST_KEYS,
  usePersistedExpanded,
} from '@/shared/stores/useUiPreferencesStore';
import { formatClock, formatRelativeTime } from '@/shared/lib/date';
import { statusFirstSentence, statusParagraphs } from '@/shared/lib/statusNote';
import { useLiveStatus } from '../model/hooks/useLiveStatus';
import { ArtifactPreviewDialog, useExecutionArtifacts } from './ArtifactCards';
import { findSegmentArtifact } from './artifact-preview';

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
  const row = useMemo(() => {
    const rows = [...activeWorkspaces, ...archivedWorkspaces].filter(
      (workspace) => workspace.id === workspaceId
    );
    return (
      rows.find((workspace) => (workspace.hostId ?? null) === hostId) ?? rows[0]
    );
  }, [activeWorkspaces, archivedWorkspaces, workspaceId, hostId]);
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
      return process?.completed_at ?? process?.started_at ?? null;
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
        processId: item.executionProcessId,
      }));
    if (!current) return past;
    // A stored note is dated by the row; the turn that wrote it (if loaded)
    // still owns its attachments.
    const processId =
      live?.executionProcessId ??
      history.find((item) => item.text === current)?.executionProcessId;
    return [{ text: current, at: currentAt, processId }, ...past];
  }, [current, currentAt, history, live?.executionProcessId, processTime]);

  // The reader's position is the summary text, not an index, so a new block
  // arriving in front does not change what they are looking at.
  const [viewedText, setViewedText] = useState<string | null>(null);
  const viewIndex = viewedText
    ? Math.max(
        0,
        items.findIndex((item) => item.text === viewedText)
      )
    : 0;
  // A newly stored summary returns the reader to the latest one; tokens of a
  // streaming block do not.
  useEffect(() => {
    if (!streaming) setViewedText(null);
  }, [current, streaming]);
  const viewed = items[viewIndex];
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

  const [open, toggle] = usePersistedExpanded(
    PERSIST_KEYS.workspaceStatusStrip,
    false
  );
  const onToggle = useCallback(() => {
    setViewedText(null);
    toggle();
  }, [toggle]);

  // Attachments are looked up on the process that wrote the viewed summary,
  // else the session's latest process; a note from an older session falls
  // through to the file viewer.
  const processId =
    viewed?.processId ?? processes?.executionProcessesAll.at(-1)?.id;
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
  const isPast = viewIndex > 0;
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
      canPrev={viewIndex < items.length - 1}
      canNext={viewIndex > 0}
      onPrev={() => {
        const older = items[viewIndex + 1];
        if (older) setViewedText(older.text);
      }}
      onNext={() => {
        const newer = items[viewIndex - 1];
        setViewedText(viewIndex - 1 > 0 && newer ? newer.text : null);
      }}
      onOpenLink={onOpenLink}
    />
  );
}
