import { useEffect, useRef } from 'react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { TerminalPanel } from '@vibe/ui/components/TerminalPanel';
import { XTermInstance } from './XTermInstance';

/** Tab-store key for the standalone terminal, which belongs to no workspace. */
const HOME_TERMINAL_KEY = 'home';

/**
 * A shell that exits sooner than this after starting is treated as broken and
 * not respawned; the panel stays empty until it is reopened. Long enough that
 * `exit` typed by a person always gets a fresh shell.
 */
const RESPAWN_FLOOR_MS = 1500;

/**
 * Tabs for one terminal scope. `tabKey` partitions the tab store; `workspaceId`
 * is what decides the shell's cwd server-side — omitted means `$HOME`.
 */
function TerminalTabs({
  tabKey,
  workspaceId,
}: {
  tabKey: string;
  workspaceId?: string;
}) {
  const { getTabsForWorkspace, getActiveTab, createTab, closeTab } =
    useTerminal();

  const tabs = getTabsForWorkspace(tabKey);
  const activeTab = getActiveTab(tabKey);
  // Doubles as the in-flight guard (a create stays pending until the tab shows
  // up) and as a respawn floor: a shell that dies the moment it starts — a
  // profile that calls `exit`, a broken login file — closes its tab on the exit
  // frame, and recreating unconditionally would spin up PTYs forever.
  const lastCreateRef = useRef(0);

  useEffect(() => {
    if (tabs.length > 0) return;
    if (Date.now() - lastCreateRef.current < RESPAWN_FLOOR_MS) return;
    lastCreateRef.current = Date.now();
    createTab(tabKey);
  }, [tabKey, tabs.length, createTab]);

  return (
    <TerminalPanel
      tabs={tabs}
      activeTabId={activeTab?.id ?? null}
      renderTab={(tabId, isActive) => (
        <XTermInstance
          key={tabId}
          tabId={tabId}
          workspaceId={workspaceId}
          isActive={isActive}
          onClose={() => closeTab(tabKey, tabId)}
        />
      )}
    />
  );
}

/** Terminal for the selected workspace, rooted at its worktree. */
export function TerminalPanelContainer() {
  const { workspace } = useWorkspaceContext();
  const { clearWorkspaceTabs } = useTerminal();

  const workspaceId = workspace?.id;
  const hasWorkspaceDir = !!workspace?.container_ref;
  const prevWorkspaceIdRef = useRef<string | null>(null);

  // Clean up terminals when workspace changes
  useEffect(() => {
    if (
      prevWorkspaceIdRef.current &&
      prevWorkspaceIdRef.current !== workspaceId
    ) {
      clearWorkspaceTabs(prevWorkspaceIdRef.current);
    }
    prevWorkspaceIdRef.current = workspaceId ?? null;
  }, [workspaceId, clearWorkspaceTabs]);

  if (!workspaceId || !hasWorkspaceDir) return null;
  // Keyed so switching workspaces gets a fresh scope rather than carrying the
  // previous one's in-flight create guard.
  return (
    <TerminalTabs
      key={workspaceId}
      tabKey={workspaceId}
      workspaceId={workspaceId}
    />
  );
}

/** Standalone terminal pane: no workspace, starts in the user's home directory. */
export function HomeTerminalPanel() {
  return <TerminalTabs tabKey={HOME_TERMINAL_KEY} />;
}
