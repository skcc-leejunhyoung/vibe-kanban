import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { WorkspacePaneScope } from '@/shared/components/workspace-panes/WorkspacePaneScope';
import {
  PRIMARY_PANE_ID,
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

const paneSeparator = (
  <Separator className="relative z-10 w-1 shrink-0 bg-border/60 transition-colors hover:bg-brand data-[resize-handle-active]:bg-brand" />
);

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
      containerRef.current?.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSerial]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="relative flex h-full min-h-0 flex-col overflow-hidden outline-none"
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 z-20 border border-brand transition-opacity',
          active && showActiveRing ? 'opacity-60' : 'opacity-0'
        )}
      />
      {children}
    </div>
  );
}

function PaneHeaderShell({
  title,
  onClose,
}: {
  title: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-secondary px-2">
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
function WorkspacePaneTitle() {
  const { workspace } = useWorkspaceContext();
  return <>{workspace?.name ?? '…'}</>;
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
      return (
        <>
          <KanbanPaneShortcuts enabled={isPaneActive} />
          <ProjectKanban />
        </>
      );
    case 'pull-requests':
      return <PullRequestsPage />;
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
      return <WorkspacePaneTitle />;
    case 'project':
    case 'project-issue':
    case 'project-issue-workspace':
      return t('workspacePanes.projectPane', { defaultValue: 'Project' });
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
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (destination: WorkspacePaneDestination) => void;
}) {
  // Document-scope context: the workspace list shared with the sidebar.
  const { activeWorkspaces } = useWorkspaceContext();
  const { t } = useTranslation('common');

  return (
    <div className="flex h-full min-h-0 flex-col bg-primary">
      <PaneHeaderShell
        title={
          <span className="text-low">
            {t('workspacePanes.emptyPaneTitle', { defaultValue: 'New pane' })}
          </span>
        }
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="px-2 py-1 text-xs text-low">
          {t('workspacePanes.pickWorkspace', {
            defaultValue: 'Choose a workspace for this pane',
          })}
        </p>
        {activeWorkspaces.map((workspace) => (
          <button
            key={`${workspace.hostId ?? 'local'}:${workspace.id}`}
            type="button"
            onClick={() =>
              onPick({
                kind: 'workspace',
                workspaceId: workspace.id,
                hostId: workspace.hostId ?? null,
              })
            }
            className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm text-normal hover:bg-secondary cursor-pointer"
          >
            {workspace.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function SecondaryWorkspacePane({
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
          destination={pane.destination}
          onNavigate={handleNavigate}
        >
          <div className="flex h-full min-h-0 flex-col bg-primary">
            <PaneHeaderShell
              title={paneTitle(pane.destination, t)}
              onClose={() => closePane(pane.id)}
            />
            <div className="min-h-0 flex-1">
              <PaneOutlet
                destination={pane.destination}
                isPaneActive={active}
              />
            </div>
          </div>
        </WorkspacePaneScope>
      ) : (
        <EmptyPane onClose={() => closePane(pane.id)} onPick={handleNavigate} />
      )}
    </PaneChrome>
  );
}

/**
 * In-document split grid for the workspaces page: the routed primary view
 * plus zero or more panes (workspace, kanban, pull requests, notifications)
 * side by side. With no secondary panes (or on unsupported surfaces) it
 * renders the primary view untouched.
 */
// ponytail: single-row split only; add row wrapping if >4 panes sees real use.
export function WorkspacePaneGrid({ primary }: { primary: ReactNode }) {
  const appRuntime = useAppRuntime();
  const isMobile = useIsMobile();
  const panes = useWorkspacePanesStore((s) => s.panes);
  const activePaneId = useWorkspacePanesStore((s) => s.activePaneId);
  const storedLayout = useWorkspacePanesStore((s) => s.layout);
  const setLayout = useWorkspacePanesStore((s) => s.setLayout);
  const setActivePane = useWorkspacePanesStore((s) => s.setActivePane);

  const handleLayoutChange = useCallback(
    (layout: Layout) => setLayout(layout),
    [setLayout]
  );

  if (appRuntime !== 'local' || isMobile || panes.length === 0) {
    return <>{primary}</>;
  }

  const slotIds = [PRIMARY_PANE_ID, ...panes.map((pane) => pane.id)];
  const defaultLayout: Layout = Object.fromEntries(
    slotIds.map((id) => [id, storedLayout[id] ?? 100 / slotIds.length])
  );

  return (
    <Group
      orientation="horizontal"
      className="h-full min-h-0"
      defaultLayout={defaultLayout}
      onLayoutChange={handleLayoutChange}
    >
      <Panel
        id={PRIMARY_PANE_ID}
        minSize={15}
        className="min-w-0 h-full overflow-hidden"
      >
        <PaneChrome
          active={activePaneId === null}
          showActiveRing
          onActivate={() => setActivePane(null)}
        >
          {primary}
        </PaneChrome>
      </Panel>
      {panes.map((pane) => (
        <Fragment key={pane.id}>
          {paneSeparator}
          <Panel
            id={pane.id}
            minSize={15}
            className="min-w-0 h-full overflow-hidden"
          >
            <SecondaryWorkspacePane
              pane={pane}
              active={activePaneId === pane.id}
              showActiveRing
            />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
