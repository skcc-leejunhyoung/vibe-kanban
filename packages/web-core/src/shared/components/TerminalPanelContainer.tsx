import { useEffect, useRef } from 'react';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { TerminalPanel } from '@vibe/ui/components/TerminalPanel';
import { XTermInstance } from './XTermInstance';

/** Tab-store key for the standalone terminal, which belongs to no workspace. */
const HOME_TERMINAL_KEY = 'home';

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
  const creatingRef = useRef(false);

  useEffect(() => {
    if (tabs.length === 0 && !creatingRef.current) {
      creatingRef.current = true;
      createTab(tabKey);
    }
    if (tabs.length > 0) {
      creatingRef.current = false;
    }
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
