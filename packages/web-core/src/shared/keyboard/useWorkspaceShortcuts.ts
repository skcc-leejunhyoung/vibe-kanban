import { useCallback, useRef, useEffect } from 'react';
import { useActions } from '@/shared/hooks/useActions';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { Actions } from '@/shared/actions';
import {
  type ActionDefinition,
  ActionTargetType,
} from '@/shared/types/actions';
import { Scope, resolveSequence } from '@/shared/keyboard/registry';
import { useReboundHotkey } from '@/shared/keyboard/useReboundHotkey';
import { useKeyboardShortcutsStore } from '@/shared/stores/useKeyboardShortcutsStore';

const SEQUENCE_TIMEOUT_MS = 1500;

const OPTIONS = {
  scopes: [Scope.WORKSPACE],
  sequenceTimeout: SEQUENCE_TIMEOUT_MS,
} as const;

interface UseWorkspaceShortcutsOptions {
  /**
   * Gate for split panes: the document instance passes false while a
   * secondary workspace pane is focused (that pane mounts its own instance),
   * so exactly one registration answers each sequence.
   */
  enabled?: boolean;
}

export function useWorkspaceShortcuts(options?: UseWorkspaceShortcutsOptions) {
  const { executeAction } = useActions();
  const { workspaceId, repos, startNewSession } = useWorkspaceContext();
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);
  const hotkeyOptions = { ...OPTIONS, enabled: options?.enabled ?? true };

  const workspaceIdRef = useRef(workspaceId);
  const reposRef = useRef(repos);
  const executeActionRef = useRef(executeAction);
  const startNewSessionRef = useRef(startNewSession);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    reposRef.current = repos;
    executeActionRef.current = executeAction;
    startNewSessionRef.current = startNewSession;
  });

  const execute = useCallback((action: ActionDefinition) => {
    const currentWorkspaceId = workspaceIdRef.current;
    const currentRepos = reposRef.current;
    const currentExecuteAction = executeActionRef.current;
    const firstRepoId = currentRepos?.[0]?.id;

    switch (action.requiresTarget) {
      case ActionTargetType.GIT:
        currentExecuteAction(action, currentWorkspaceId, firstRepoId);
        break;
      case ActionTargetType.WORKSPACE:
        currentExecuteAction(action, currentWorkspaceId);
        break;
      case ActionTargetType.NONE:
      case ActionTargetType.ISSUE:
        currentExecuteAction(action);
        break;
    }
  }, []);

  // Resolve the effective key for a binding id, honoring user overrides.
  const seq = (id: string) => resolveSequence(id, overrides);

  // Re-register hotkeys when overrides change so rebinds take effect live.
  useReboundHotkey(
    seq('seq-go-settings'),
    () => execute(Actions.Settings),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-go-new-workspace'),
    () => execute(Actions.NewWorkspace),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-go-quick-chat'),
    () => execute(Actions.QuickChat),
    hotkeyOptions,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-workspace-new-session'),
    () => startNewSessionRef.current(),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-duplicate'),
    () => execute(Actions.DuplicateWorkspace),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-rename'),
    () => execute(Actions.RenameWorkspace),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-pin'),
    () => execute(Actions.PinWorkspace),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-archive'),
    () => execute(Actions.ArchiveWorkspace),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-delete'),
    () => execute(Actions.DeleteWorkspace),
    hotkeyOptions,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-view-changes'),
    () => execute(Actions.ToggleChangesMode),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-logs'),
    () => execute(Actions.ToggleLogsMode),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-preview'),
    () => execute(Actions.TogglePreviewMode),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-sidebar'),
    () => execute(Actions.ToggleLeftSidebar),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-right-sidebar'),
    () => execute(Actions.ToggleRightSidebar),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-chat'),
    () => execute(Actions.ToggleLeftMainPanel),
    hotkeyOptions,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-git-pr'),
    () => execute(Actions.GitCreatePR),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-git-merge'),
    () => execute(Actions.GitMerge),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-git-commit'),
    () => execute(Actions.GitCommit),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-git-rebase'),
    () => execute(Actions.GitRebase),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-git-push'),
    () => execute(Actions.GitPush),
    hotkeyOptions,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-yank-path'),
    () => execute(Actions.CopyWorkspacePath),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-yank-logs'),
    () => execute(Actions.CopyRawLogs),
    hotkeyOptions,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-toggle-dev-server'),
    () => execute(Actions.ToggleDevServer),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-toggle-wrap'),
    () => execute(Actions.ToggleWrapLines),
    hotkeyOptions,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-run-setup'),
    () => execute(Actions.RunSetupScript),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-run-cleanup'),
    () => execute(Actions.RunCleanupScript),
    hotkeyOptions,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-run-archive'),
    () => execute(Actions.RunArchiveScript),
    hotkeyOptions,
    [overrides]
  );
}
