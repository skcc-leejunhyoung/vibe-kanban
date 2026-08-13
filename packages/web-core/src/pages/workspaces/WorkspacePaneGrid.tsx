import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
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
import {
  paneDestinationKey,
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

function EmptyPane() {
  return <WorkspacesSidebarContainer isStandalonePage forceMobile />;
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
          destination={pane.destination}
          onNavigate={handleNavigate}
        >
          <div className="flex h-full min-h-0 flex-col bg-primary">
            <PaneHeaderShell
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
        </WorkspacePaneScope>
      ) : (
        <EmptyPane />
      )}
    </PaneChrome>
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
  const setLayout = useWorkspacePanesStore((s) => s.setLayout);
  const [groupHandle, setGroupHandle] = useGroupCallbackRef();

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
    const state = useWorkspacePanesStore.getState();
    const fallback = 100 / Math.max(state.panes.length, 1);
    groupHandle.setLayout(
      Object.fromEntries(
        state.panes.map((pane) => [pane.id, state.layout[pane.id] ?? fallback])
      )
    );
    structuralPendingRef.current = false;
  }, [paneIdsSignature, groupHandle]);

  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      if (structuralPendingRef.current) return;
      setLayout(layout);
    },
    [setLayout]
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
          {index > 0 && paneSeparator}
          <Panel
            id={pane.id}
            minSize={10}
            className="min-w-0 h-full overflow-hidden"
          >
            <WorkspacePaneView
              pane={pane}
              active={activePaneId === pane.id}
              showActiveRing={showActiveRing}
            />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
