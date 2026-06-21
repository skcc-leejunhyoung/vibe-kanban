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

export function useWorkspaceShortcuts() {
  const { executeAction } = useActions();
  const { workspaceId, repos } = useWorkspaceContext();
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);

  const workspaceIdRef = useRef(workspaceId);
  const reposRef = useRef(repos);
  const executeActionRef = useRef(executeAction);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    reposRef.current = repos;
    executeActionRef.current = executeAction;
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
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-go-new-workspace'),
    () => execute(Actions.NewWorkspace),
    OPTIONS,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-workspace-duplicate'),
    () => execute(Actions.DuplicateWorkspace),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-rename'),
    () => execute(Actions.RenameWorkspace),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-pin'),
    () => execute(Actions.PinWorkspace),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-archive'),
    () => execute(Actions.ArchiveWorkspace),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-workspace-delete'),
    () => execute(Actions.DeleteWorkspace),
    OPTIONS,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-view-changes'),
    () => execute(Actions.ToggleChangesMode),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-logs'),
    () => execute(Actions.ToggleLogsMode),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-preview'),
    () => execute(Actions.TogglePreviewMode),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-sidebar'),
    () => execute(Actions.ToggleLeftSidebar),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-view-chat'),
    () => execute(Actions.ToggleLeftMainPanel),
    OPTIONS,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-git-pr'),
    () => execute(Actions.GitCreatePR),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-git-merge'),
    () => execute(Actions.GitMerge),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-git-rebase'),
    () => execute(Actions.GitRebase),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-git-push'),
    () => execute(Actions.GitPush),
    OPTIONS,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-yank-path'),
    () => execute(Actions.CopyWorkspacePath),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-yank-logs'),
    () => execute(Actions.CopyRawLogs),
    OPTIONS,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-toggle-dev-server'),
    () => execute(Actions.ToggleDevServer),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-toggle-wrap'),
    () => execute(Actions.ToggleWrapLines),
    OPTIONS,
    [overrides]
  );

  useReboundHotkey(
    seq('seq-run-setup'),
    () => execute(Actions.RunSetupScript),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-run-cleanup'),
    () => execute(Actions.RunCleanupScript),
    OPTIONS,
    [overrides]
  );
  useReboundHotkey(
    seq('seq-run-archive'),
    () => execute(Actions.RunArchiveScript),
    OPTIONS,
    [overrides]
  );
}
