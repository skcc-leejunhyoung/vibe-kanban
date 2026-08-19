import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Group,
  Panel,
  Separator,
  useGroupCallbackRef,
  type Layout,
} from 'react-resizable-panels';
import { XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { WorkspacePaneScope } from '@/shared/components/workspace-panes/WorkspacePaneScope';
import { PaneWidthProvider } from '@/shared/components/workspace-panes/PaneWidthContext';
import { PaneActiveProvider } from '@/shared/components/workspace-panes/PaneActiveContext';
import {
  paneDestinationKey,
  resizePaneProportionally,
  useWorkspacePanesStore,
  type WorkspacePane,
  type WorkspacePaneDestination,
} from '@/shared/stores/useWorkspacePanesStore';
import { ProjectKanban } from '@/pages/kanban/ProjectKanban';
import { PullRequestsPage } from '@/pages/pull-requests/PullRequestsPage';
import { useIssueShortcuts } from '@/shared/keyboard/useIssueShortcuts';
import { useWorkspaceShortcuts } from '@/shared/keyboard/useWorkspaceShortcuts';
import { NotificationsPage } from './NotificationsPage';
import { WorkspaceDetail } from './WorkspaceDetail';
import { WorkspacesSidebarContainer } from './WorkspacesSidebarContainer';
import { GithubIssueBadge, PrBadge } from '@vibe/ui/components/PrBadge';
import { useWorkspaceIssueGrouping } from '@/shared/hooks/useWorkspaceIssueGrouping';
import { getHostWorkspaceKey } from '@/shared/hooks/useWorkspaces';
import { ProjectProvider } from '@/shared/providers/remote/ProjectProvider';
import { useProjectContext } from '@/shared/hooks/useProjectContext';

/**
 * Pane-scoped keyboard registrations: they read the pane's context (workspace,
 * repos, sessions, actions), so sequences act on the pane — the document-level
 * instances are gated off / inert while this pane is focused.
 */
function WorkspacePaneShortcuts({ enabled }: { enabled: boolean }) {
  useWorkspaceShortcuts({ enabled });
  return null;
}

function KanbanPaneShortcuts({ enabled }: { enabled: boolean }) {
  useIssueShortcuts({ enabled });
  return null;
}

const paneSeparatorClassName =
  'relative z-10 w-1 shrink-0 bg-border/60 transition-colors hover:bg-brand data-[resize-handle-active]:bg-brand';

function PaneChrome({
  active,
  showActiveRing,
  onActivate,
  children,
}: {
  active: boolean;
  showActiveRing: boolean;
  onActivate: () => void;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusSerial = useWorkspacePanesStore((s) => s.focusSerial);

  // Move DOM focus only for keyboard pane cycling (focusSerial bumps), never
  // for pointer activation — that would steal focus from the clicked control.
  useEffect(() => {
    if (focusSerial > 0 && active) {
      const target =
        containerRef.current?.querySelector<HTMLElement>(
          '[data-workspace-selector]'
        ) ?? containerRef.current;
      target?.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSerial]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-workspace-pane
      className="relative flex h-full min-h-0 flex-col overflow-hidden outline-none"
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 z-30 border border-brand transition-opacity',
          active && showActiveRing ? 'opacity-60' : 'opacity-0'
        )}
      />
      {children}
    </div>
  );
}

function PaneHeaderShell({
  paneId,
  title,
  onClose,
}: {
  paneId: string;
  title: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const movePane = useWorkspacePanesStore((s) => s.movePane);
  const [dropAfter, setDropAfter] = useState<boolean | null>(null);
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', paneId);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const { left, width } = event.currentTarget.getBoundingClientRect();
        setDropAfter(event.clientX > left + width / 2);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDropAfter(null);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const { left, width } = event.currentTarget.getBoundingClientRect();
        movePane(
          event.dataTransfer.getData('text/plain'),
          paneId,
          event.clientX > left + width / 2
        );
        setDropAfter(null);
      }}
      onDragEnd={() => setDropAfter(null)}
      className="relative flex h-7 shrink-0 cursor-grab items-center gap-2 border-b border-border bg-secondary px-2 active:cursor-grabbing"
    >
      {dropAfter !== null && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 z-40 w-1 bg-brand',
            dropAfter ? '-right-0.5' : '-left-0.5'
          )}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-normal">
        {title}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('workspacePanes.closePane', {
          defaultValue: 'Close pane',
        })}
        className="rounded-sm p-0.5 text-low hover:text-normal cursor-pointer"
      >
        <XIcon className="h-3.5 w-3.5" weight="bold" />
      </button>
    </div>
  );
}

/** Header title for workspace panes — reads the pane-scoped context. */
function WorkspacePaneTitle({ hostId }: { hostId: string | null }) {
  const { workspace, activeWorkspaces, archivedWorkspaces } =
    useWorkspaceContext();
  const issueMeta = useWorkspaceIssueGrouping();
  const summary = [...activeWorkspaces, ...archivedWorkspaces].find(
    (candidate) => candidate.id === workspace?.id && candidate.hostId === hostId
  );
  const githubIssues = workspace
    ? (issueMeta.get(getHostWorkspaceKey(workspace.id, hostId))?.githubIssues ??
      [])
    : [];

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {summary?.prNumber &&
        summary.prUrl &&
        summary.prStatus &&
        summary.prStatus !== 'unknown' && (
          <PrBadge
            number={summary.prNumber}
            url={summary.prUrl}
            status={summary.prStatus}
          />
        )}
      {githubIssues.map((issue) => (
        <GithubIssueBadge key={issue.id} {...issue} />
      ))}
      <span className="truncate">{workspace?.name ?? '…'}</span>
    </span>
  );
}

function ProjectIssuePaneTitle({
  issueId,
  label,
}: {
  issueId: string;
  label: string;
}) {
  const { pullRequests, pullRequestIssues, githubIssueLinks } =
    useProjectContext();
  const linkedPrIds = new Set(
    pullRequestIssues
      .filter((link) => link.issue_id === issueId)
      .map((link) => link.pull_request_id)
  );

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {pullRequests
        .filter((pr) => linkedPrIds.has(pr.id))
        .map((pr) => (
          <PrBadge
            key={pr.id}
            number={pr.number}
            url={pr.url}
            status={pr.status}
          />
        ))}
      {githubIssueLinks
        .filter((link) => link.issue_id === issueId)
        .map((issue) => (
          <GithubIssueBadge key={issue.id} {...issue} />
        ))}
      <span className="truncate">{label}</span>
    </span>
  );
}

function ProjectPaneTitle({
  destination,
  label,
}: {
  destination: Extract<WorkspacePaneDestination, { kind: `project${string}` }>;
  label: string;
}) {
  if (!('issueId' in destination)) return <>{label}</>;
  return (
    <ProjectProvider projectId={destination.projectId}>
      <ProjectIssuePaneTitle issueId={destination.issueId} label={label} />
    </ProjectProvider>
  );
}

function PaneOutlet({
  destination,
  isPaneActive,
}: {
  destination: WorkspacePaneDestination;
  isPaneActive: boolean;
}) {
  switch (destination.kind) {
    case 'workspace':
      return (
        <>
          <WorkspacePaneShortcuts enabled={isPaneActive} />
          <WorkspaceDetail isPaneActive={isPaneActive} />
        </>
      );
    case 'project':
    case 'project-issue':
    case 'project-issue-workspace':
    case 'project-issue-workspace-create':
    case 'project-workspace-create':
      return (
        <>
          <KanbanPaneShortcuts enabled={isPaneActive} />
          <ProjectKanban />
        </>
      );
    case 'pull-requests':
      return <PullRequestsPage initialPrUrl={destination.prUrl} />;
    case 'notifications':
      return <NotificationsPage />;
  }
}

function paneTitle(
  destination: WorkspacePaneDestination,
  t: (key: string, options: { defaultValue: string }) => string
): ReactNode {
  switch (destination.kind) {
    case 'workspace':
      return <WorkspacePaneTitle hostId={destination.hostId ?? null} />;
    case 'project':
    case 'project-workspace-create':
      return t('workspacePanes.projectPane', { defaultValue: 'Project' });
    case 'project-issue':
    case 'project-issue-workspace':
    case 'project-issue-workspace-create':
      return (
        <ProjectPaneTitle
          destination={destination}
          label={t('workspacePanes.projectPane', { defaultValue: 'Project' })}
        />
      );
    case 'pull-requests':
      return t('workspacePanes.pullRequestsPane', {
        defaultValue: 'Pull requests',
      });
    case 'notifications':
      return t('workspacePanes.notificationsPane', {
        defaultValue: 'Notifications',
      });
  }
}

function EmptyPane({
  paneId,
  onClose,
}: {
  paneId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-full min-h-0 flex-col bg-primary">
      <PaneHeaderShell
        paneId={paneId}
        title={t('workspacePanes.emptyPaneTitle', {
          defaultValue: 'New pane',
        })}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1">
        <WorkspacesSidebarContainer
          isStandalonePage
          forceMobile
          targetPaneId={paneId}
        />
      </div>
    </div>
  );
}

function WorkspacePaneView({
  pane,
  active,
  showActiveRing,
}: {
  pane: WorkspacePane;
  active: boolean;
  showActiveRing: boolean;
}) {
  const { t } = useTranslation('common');
  const setActivePane = useWorkspacePanesStore((s) => s.setActivePane);
  const setPaneDestination = useWorkspacePanesStore(
    (s) => s.setPaneDestination
  );
  const closePane = useWorkspacePanesStore((s) => s.closePane);

  const handleNavigate = useCallback(
    (destination: WorkspacePaneDestination) => {
      setPaneDestination(pane.id, destination);
    },
    [pane.id, setPaneDestination]
  );

  return (
    <PaneChrome
      active={active}
      showActiveRing={showActiveRing}
      onActivate={() => setActivePane(pane.id)}
    >
      {pane.destination ? (
        <WorkspacePaneScope
          key={paneDestinationKey(pane.destination)}
          paneId={pane.id}
          destination={pane.destination}
          onNavigate={handleNavigate}
        >
          <PaneActiveProvider active={active}>
            <div className="flex h-full min-h-0 flex-col bg-primary">
              <PaneHeaderShell
                paneId={pane.id}
                title={paneTitle(pane.destination, t)}
                onClose={() => closePane(pane.id)}
              />
              <div className="min-h-0 flex-1">
                <PaneWidthProvider>
                  <PaneOutlet
                    destination={pane.destination}
                    isPaneActive={active}
                  />
                </PaneWidthProvider>
              </div>
            </div>
          </PaneActiveProvider>
        </WorkspacePaneScope>
      ) : (
        <EmptyPane paneId={pane.id} onClose={() => closePane(pane.id)} />
      )}
    </PaneChrome>
  );
}

function WorkspaceGridPanel({
  pane,
  active,
  showActiveRing,
  registrationVersion,
}: {
  pane: WorkspacePane;
  active: boolean;
  showActiveRing: boolean;
  registrationVersion: number;
}) {
  return (
    <Panel
      id={pane.id}
      // Equivalent values force the ordered registry to refresh on reorder.
      minSize={registrationVersion % 2 ? '10%' : '10.0%'}
      className="min-w-0 h-full overflow-hidden"
    >
      <WorkspacePaneView
        pane={pane}
        active={active}
        showActiveRing={showActiveRing}
      />
    </Panel>
  );
}

/**
 * The in-document pane grid: every pane (workspace, kanban, pull requests,
 * notifications) is a store-owned equal — there is no route-bound primary.
 * Structural changes get their layout from the store (VS Code split
 * semantics); onLayoutChange persists user drags.
 */
// ponytail: single-row split only; add row wrapping if >4 panes sees real use.
export function WorkspacePaneGrid() {
  const panes = useWorkspacePanesStore((s) => s.panes);
  const activePaneId = useWorkspacePanesStore((s) => s.activePaneId);
  const storedLayout = useWorkspacePanesStore((s) => s.layout);
  const paneOrderVersion = useWorkspacePanesStore((s) => s.paneOrderVersion);
  const setLayout = useWorkspacePanesStore((s) => s.setLayout);
  const [groupHandle, setGroupHandle] = useGroupCallbackRef();
  const resizeRef = useRef<{ paneId: string; layout: Layout } | null>(null);
  const applyingLayoutRef = useRef(false);

  // Structural changes (pane added/closed) must apply the store-computed
  // layout without remounting the Group — a keyed remount would tear down
  // every pane's streams and providers. The library redistributes sizes when
  // panels mount/unmount; we suppress persisting that echo (flag set during
  // render, before child effects) and then impose the store layout.
  const paneIdsSignature = panes.map((pane) => pane.id).join(',');
  const lastSignatureRef = useRef(paneIdsSignature);
  const structuralPendingRef = useRef(false);
  if (lastSignatureRef.current !== paneIdsSignature) {
    lastSignatureRef.current = paneIdsSignature;
    structuralPendingRef.current = true;
  }

  useEffect(() => {
    if (!structuralPendingRef.current || !groupHandle) return;
    const frame = requestAnimationFrame(() => {
      const state = useWorkspacePanesStore.getState();
      const fallback = 100 / Math.max(state.panes.length, 1);
      groupHandle.setLayout(
        Object.fromEntries(
          state.panes.map((pane) => [
            pane.id,
            state.layout[pane.id] ?? fallback,
          ])
        )
      );
      structuralPendingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [paneIdsSignature, groupHandle]);

  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      if (structuralPendingRef.current || applyingLayoutRef.current) return;
      const resize = resizeRef.current;
      if (resize && groupHandle) {
        const proportionalLayout = resizePaneProportionally(
          resize.layout,
          resize.paneId,
          layout[resize.paneId],
          10
        );
        applyingLayoutRef.current = true;
        groupHandle.setLayout(proportionalLayout);
        applyingLayoutRef.current = false;
        setLayout(proportionalLayout);
        return;
      }
      setLayout(layout);
    },
    [groupHandle, setLayout]
  );

  if (panes.length === 0) return null;

  const fallbackSize = 100 / panes.length;
  const defaultLayout: Layout = Object.fromEntries(
    panes.map((pane) => [pane.id, storedLayout[pane.id] ?? fallbackSize])
  );
  const showActiveRing = panes.length > 1;

  return (
    <Group
      groupRef={setGroupHandle}
      orientation="horizontal"
      className="h-full min-h-0"
      defaultLayout={defaultLayout}
      onLayoutChange={handleLayoutChange}
    >
      {panes.map((pane, index) => (
        <Fragment key={pane.id}>
          {index > 0 && (
            <Separator
              className={paneSeparatorClassName}
              onPointerDownCapture={() => {
                resizeRef.current = {
                  paneId: panes[index - 1].id,
                  layout: groupHandle?.getLayout() ?? defaultLayout,
                };
              }}
              onPointerUp={() => (resizeRef.current = null)}
              onPointerCancel={() => (resizeRef.current = null)}
              onKeyDownCapture={() => {
                resizeRef.current = {
                  paneId: panes[index - 1].id,
                  layout: groupHandle?.getLayout() ?? defaultLayout,
                };
              }}
              onKeyUp={() => (resizeRef.current = null)}
              onBlur={() => (resizeRef.current = null)}
            />
          )}
          <WorkspaceGridPanel
            pane={pane}
            active={activePaneId === pane.id}
            showActiveRing={showActiveRing}
            registrationVersion={paneOrderVersion}
          />
        </Fragment>
      ))}
    </Group>
  );
}
