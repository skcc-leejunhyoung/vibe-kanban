import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ChatCircleIcon,
  PaperPlaneRightIcon,
  PushPinIcon,
  RobotIcon,
  UserIcon,
} from '@phosphor-icons/react';
import type {
  CreateDrawerCommentRequest,
  DrawerComment,
  DrawerNote,
} from 'shared/remote-types';
import { cn } from '@vibe/ui/lib/cn';
import { useDrawerComments, useDrawerNotes } from '@/shared/hooks/useDrawer';
import { getResolvedTheme, useTheme } from '@/shared/hooks/useTheme';
import { isDrawerNoteUnread } from '@/shared/lib/drawer';
import { formatDateTimeFull, formatRelativeTime } from '@/shared/lib/date';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { HostIdContext } from '@/shared/providers/HostIdProvider';
import {
  ArtifactCards,
  useExecutionArtifacts,
} from '@/features/workspace-chat/ui/ArtifactCards';
import {
  findSegmentArtifact,
  splitArtifactSegments,
} from '@/features/workspace-chat/ui/artifact-preview';

/**
 * The Drawer tab of the Quick chat dialog: notes the Autopilot wrote (title +
 * markdown body with artifact tiles) and a comment thread per note. The user
 * reads, comments, archives and restores; writing notes is the Autopilot's job
 * (`vk drawer`), so there is no editor here. Explanations live in tooltips —
 * the surface itself stays bare.
 */
export function DrawerTab({
  initialNoteId,
}: {
  initialNoteId?: string | null;
}) {
  const notes = useDrawerNotes();
  const comments = useDrawerComments();
  const [view, setView] = useState<'inbox' | 'archive'>('inbox');
  const [selectedId, setSelectedId] = useState<string | null>(
    initialNoteId ?? null
  );
  // Narrow layouts show either the list or the note; wide ones show both.
  const [showDetailOnNarrow, setShowDetailOnNarrow] = useState(!!initialNoteId);

  const list = view === 'inbox' ? notes.inbox : notes.archived;
  // Only a note the user picked (or was deep-linked to) is shown: an implicit
  // "first note" would be marked read without anyone opening it, and a note
  // the Autopilot moved to the other view drops out of the detail pane.
  const selected = useMemo(
    () => list.find((note) => note.id === selectedId) ?? null,
    [list, selectedId]
  );

  // A deep link (also one arriving while the tab is already open) selects its
  // note and switches to the view the note lives in — once per link, so a
  // later archive or view change by the user is not undone by the next sync.
  const linkedViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialNoteId) return;
    setSelectedId(initialNoteId);
    setShowDetailOnNarrow(true);
  }, [initialNoteId]);
  useEffect(() => {
    if (!initialNoteId || linkedViewRef.current === initialNoteId) return;
    const target = notes.data.find((note) => note.id === initialNoteId);
    if (!target) return;
    linkedViewRef.current = initialNoteId;
    setView(target.archived_at ? 'archive' : 'inbox');
  }, [initialNoteId, notes.data]);

  // Opening a note marks it read (once per change, so a later edit or comment
  // makes it unread again). `user_seen_at` rides along so the dot clears
  // optimistically; the server sets its own timestamp.
  const seenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || !isDrawerNoteUnread(selected)) return;
    const key = `${selected.id}:${selected.updated_at}:${selected.last_comment_at ?? ''}`;
    if (seenRef.current === key) return;
    seenRef.current = key;
    const changes: Pick<DrawerNote, 'user_seen_at'> & { seen: boolean } = {
      seen: true,
      user_seen_at: new Date().toISOString(),
    };
    void notes.update(selected.id, changes).persisted.catch(() => {});
  }, [selected, notes]);

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of comments.data)
      counts.set(comment.note_id, (counts.get(comment.note_id) ?? 0) + 1);
    return counts;
  }, [comments.data]);

  const selectedComments = useMemo(
    () =>
      selected
        ? comments.data
            .filter((comment) => comment.note_id === selected.id)
            .sort(
              (a, b) =>
                new Date(a.created_at).getTime() -
                new Date(b.created_at).getTime()
            )
        : [],
    [comments.data, selected]
  );

  const archive = useCallback(
    (note: DrawerNote, archived: boolean) => {
      // `archived_at` moves the note between lists at once; the server ignores
      // it and stamps its own clock.
      const changes: Pick<DrawerNote, 'archived_at'> & { archived: boolean } = {
        archived,
        archived_at: archived ? new Date().toISOString() : null,
      };
      void notes.update(note.id, changes).persisted.catch(() => {});
      setSelectedId(null);
      setShowDetailOnNarrow(false);
    },
    [notes]
  );

  if (!notes.enabled) {
    return <p className="text-sm text-low">Sign in to see the Drawer.</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-base">
      <div
        role="tablist"
        aria-label="Drawer view"
        className="inline-flex self-start rounded-md border border-border bg-secondary p-half text-sm"
      >
        {(
          [
            ['inbox', 'Inbox', notes.inbox.length, undefined],
            [
              'archive',
              'Archive',
              notes.archived.length,
              'Deleted after 90 days',
            ],
          ] as const
        ).map(([value, label, count, hint]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            title={hint}
            onClick={() => {
              setView(value);
              setSelectedId(null);
              setShowDetailOnNarrow(false);
            }}
            className={cn(
              'inline-flex items-center gap-half rounded px-base py-half',
              view === value
                ? 'bg-panel text-high'
                : 'text-low hover:text-normal'
            )}
          >
            {label}
            {count > 0 && <span className="text-low">{count}</span>}
          </button>
        ))}
      </div>

      <div className="grid min-h-[320px] grid-cols-1 gap-base sm:grid-cols-[260px_minmax(0,1fr)]">
        <div
          className={cn(
            'flex max-h-[60vh] flex-col overflow-y-auto rounded-md border border-border bg-secondary',
            showDetailOnNarrow && 'hidden sm:flex'
          )}
        >
          {list.length === 0 && (
            <p className="p-double text-center text-sm text-low">
              {notes.isLoading
                ? 'Loading…'
                : view === 'inbox'
                  ? 'No notes'
                  : 'Nothing archived'}
            </p>
          )}
          {list.map((note) => {
            const unread = isDrawerNoteUnread(note);
            const active = selected?.id === note.id;
            const count = commentCounts.get(note.id) ?? 0;
            return (
              <button
                key={note.id}
                type="button"
                onClick={() => {
                  setSelectedId(note.id);
                  setShowDetailOnNarrow(true);
                }}
                className={cn(
                  'grid w-full grid-cols-[12px_minmax(0,1fr)] gap-half border-b border-border px-base py-plusfifty text-left last:border-b-0 hover:bg-panel/60',
                  active && 'bg-panel'
                )}
              >
                <span
                  className={cn(
                    'mt-1 size-[7px] rounded-full',
                    unread ? 'bg-brand' : 'bg-transparent'
                  )}
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      'line-clamp-2 leading-snug',
                      unread ? 'font-medium text-high' : 'text-normal'
                    )}
                  >
                    {note.pinned && (
                      <PushPinIcon
                        weight="fill"
                        className="mr-1 inline size-icon-xs text-low"
                      />
                    )}
                    {note.title}
                  </span>
                  <span className="mt-half flex items-center gap-base text-sm text-low">
                    {note.label && (
                      <span className="rounded-sm border border-brand/60 px-1 text-brand">
                        {note.label}
                      </span>
                    )}
                    <span>
                      {formatRelativeTime(noteActivityAt(note, view))}
                    </span>
                    {count > 0 && (
                      <span className="inline-flex items-center gap-[2px]">
                        <ChatCircleIcon className="size-icon-xs" />
                        {count}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div
          className={cn(
            'flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-primary',
            !showDetailOnNarrow && 'hidden sm:flex'
          )}
        >
          {selected ? (
            <NoteDetail
              note={selected}
              comments={selectedComments}
              view={view}
              onBack={() => setShowDetailOnNarrow(false)}
              onArchive={() => archive(selected, true)}
              onRestore={() => archive(selected, false)}
              onComment={(body) => {
                // `created_at` only dates the optimistic row until the server's
                // arrives; the server ignores it.
                const comment: CreateDrawerCommentRequest &
                  Pick<DrawerComment, 'created_at'> = {
                  note_id: selected.id,
                  body,
                  author: 'user',
                  created_at: new Date().toISOString(),
                };
                return comments.insert(comment).persisted;
              }}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-double text-sm text-low">
              Select a note
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** What the list's time means: last activity in the inbox, archive time in the archive. */
function noteActivityAt(note: DrawerNote, view: 'inbox' | 'archive'): string {
  if (view === 'archive' && note.archived_at) return note.archived_at;
  return note.last_comment_at && note.last_comment_at > note.updated_at
    ? note.last_comment_at
    : note.updated_at;
}

function NoteDetail({
  note,
  comments,
  view,
  onBack,
  onArchive,
  onRestore,
  onComment,
}: {
  note: DrawerNote;
  comments: DrawerComment[];
  view: 'inbox' | 'archive';
  onBack: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onComment: (body: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft('');
    setError(null);
  }, [note.id]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onComment(body);
      setDraft('');
      endRef.current?.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  }, [draft, sending, onComment]);

  const edited = note.updated_at !== note.created_at;
  return (
    <>
      <div className="flex items-start gap-base border-b border-border p-base">
        <button
          type="button"
          onClick={onBack}
          title="Back"
          aria-label="Back"
          className="mt-half shrink-0 text-low hover:text-high sm:hidden"
        >
          <ArrowLeftIcon className="size-icon-sm" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-half">
          <h3 className="text-lg font-semibold leading-snug text-high">
            {note.title}
          </h3>
          <div className="flex flex-wrap items-center gap-base text-sm text-low">
            {note.label && (
              <span className="rounded-sm border border-brand/60 px-1 text-brand">
                {note.label}
              </span>
            )}
            <RobotIcon
              weight="fill"
              className="size-icon-xs text-brand"
              aria-label="Autopilot"
            />
            <span
              title={`${edited ? 'Updated' : 'Written'} ${formatDateTimeFull(note.updated_at)}`}
            >
              {formatRelativeTime(note.updated_at)}
            </span>
            {view === 'archive' && note.archived_at && (
              <span
                className="inline-flex items-center gap-[2px]"
                title="Archived · deleted after 90 days"
              >
                <ArchiveIcon className="size-icon-xs" />
                {formatRelativeTime(note.archived_at)}
              </span>
            )}
          </div>
        </div>
        {view === 'inbox' ? (
          <button
            type="button"
            onClick={onArchive}
            title="Archive"
            className="inline-flex shrink-0 items-center gap-half rounded-md bg-brand px-base py-half text-sm font-medium text-on-brand hover:bg-brand-hover"
          >
            <ArchiveIcon className="size-icon-xs" /> Archive
          </button>
        ) : (
          <button
            type="button"
            onClick={onRestore}
            title="Back to the inbox"
            className="inline-flex shrink-0 items-center gap-half rounded-md border border-border px-base py-half text-sm text-normal hover:text-high"
          >
            <ArrowCounterClockwiseIcon className="size-icon-xs" /> Restore
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-base">
          <NoteBody note={note} />
        </div>
        <div className="flex flex-col gap-base border-t border-border p-base">
          {comments.map((comment) => (
            <div
              key={comment.id}
              className="grid grid-cols-[22px_minmax(0,1fr)] gap-base"
            >
              <span
                className={cn(
                  'flex size-[22px] items-center justify-center rounded-full',
                  comment.author === 'autopilot'
                    ? 'bg-brand/20 text-brand'
                    : 'bg-panel text-high'
                )}
                title={comment.author === 'autopilot' ? 'Autopilot' : 'You'}
              >
                {comment.author === 'autopilot' ? (
                  <RobotIcon weight="fill" className="size-icon-xs" />
                ) : (
                  <UserIcon weight="fill" className="size-icon-xs" />
                )}
              </span>
              <div className="min-w-0">
                <div className="text-sm text-low">
                  {formatRelativeTime(comment.created_at)}
                </div>
                <div className="whitespace-pre-wrap text-normal">
                  {comment.body}
                </div>
              </div>
            </div>
          ))}
          <div ref={endRef} />
          <div className="flex items-end gap-half rounded-md border border-border bg-secondary px-base py-half">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Comment…"
              rows={1}
              className="min-h-[28px] flex-1 resize-none bg-transparent py-half text-high placeholder:text-low"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!draft.trim() || sending}
              title="Send (⌘↩)"
              aria-label="Send"
              className="mb-half rounded-md bg-brand p-half text-on-brand hover:bg-brand-hover disabled:opacity-50"
            >
              <PaperPlaneRightIcon weight="fill" className="size-icon-xs" />
            </button>
          </div>
          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      </div>
    </>
  );
}

/**
 * Markdown body with `vibe-artifact` lines rendered as tiles. Artifacts are
 * looked up in the manifest of the Autopilot turn that wrote the note (its
 * host/workspace/session/execution); a line whose file was not registered
 * falls back to plain text.
 */
function NoteBody({ note }: { note: DrawerNote }) {
  const { theme } = useTheme();
  const resolved = getResolvedTheme(theme);
  const scoped =
    !!note.execution_id && !!note.workspace_id && !!note.session_id;
  const segments = useMemo(() => splitArtifactSegments(note.body), [note.body]);
  const hasArtifactLines = segments.some(
    (segment) => segment.kind !== 'markdown' && segment.kind !== 'status'
  );
  if (!scoped || !hasArtifactLines) {
    return (
      <MarkdownPreview
        content={note.body}
        theme={resolved}
        className="text-normal"
      />
    );
  }
  return (
    <HostIdContext.Provider value={note.host_id}>
      <ScopedNoteBody note={note} theme={resolved} />
    </HostIdContext.Provider>
  );
}

function ScopedNoteBody({
  note,
  theme,
}: {
  note: DrawerNote;
  theme: 'light' | 'dark';
}) {
  const processId = note.execution_id!;
  const workspaceId = note.workspace_id!;
  const sessionId = note.session_id!;
  const artifacts = useExecutionArtifacts(processId, workspaceId, sessionId);
  const all = artifacts.data?.artifacts ?? [];
  const segments = useMemo(() => splitArtifactSegments(note.body), [note.body]);
  return (
    <div className="flex flex-col gap-half">
      {segments.map((segment, index) => {
        if (segment.kind === 'markdown' || segment.kind === 'status') {
          return (
            <MarkdownPreview
              key={index}
              content={segment.text}
              theme={theme}
              className="text-normal"
            />
          );
        }
        const artifact = findSegmentArtifact(segment, all, all);
        return artifact ? (
          <ArtifactCards
            key={index}
            artifacts={[artifact]}
            processId={processId}
            workspaceId={workspaceId}
            sessionId={sessionId}
          />
        ) : (
          <p key={index} className="font-ibm-plex-mono text-sm text-low">
            {segment.raw}
          </p>
        );
      })}
    </div>
  );
}
