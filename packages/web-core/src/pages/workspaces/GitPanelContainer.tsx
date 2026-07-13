import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { workspacesApi } from '@/shared/lib/api';
import { useActions } from '@/shared/hooks/useActions';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import {
  usePushBackground,
  usePushBackgroundStore,
} from '@/shared/stores/usePushBackgroundStore';
import { useRenameBranch } from '@/shared/hooks/useRenameBranch';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { GitPanel, type RepoInfo } from '@vibe/ui/components/GitPanel';
import { Actions } from '@/shared/actions';
import type { RepoAction } from '@vibe/ui/components/RepoCard';
import type { Workspace, RepoWithTargetBranch, Merge } from 'shared/types';

export interface GitPanelContainerProps {
  selectedWorkspace: Workspace | undefined;
  repos: RepoWithTargetBranch[];
}

type PushState = 'idle' | 'pending' | 'success' | 'error';

// Stable empty map so reading push state for a workspace with no in-flight push
// doesn't create a new object each render.
const EMPTY_PUSH_STATES: Record<string, PushState> = {};

export function GitPanelContainer({
  selectedWorkspace,
  repos,
}: GitPanelContainerProps) {
  const { executeAction } = useActions();
  const queryClient = useQueryClient();
  const { t } = useTranslation('tasks');
  const { activeWorkspaces, archivedWorkspaces } = useWorkspaceContext();
  const repoActions = useUiPreferencesStore((s) => s.repoActions);
  const setRepoAction = useUiPreferencesStore((s) => s.setRepoAction);

  // Hooks for branch management (moved from WorkspacesLayout)
  const renameBranch = useRenameBranch(selectedWorkspace?.id);
  const { data: branchStatus } = useBranchStatus(selectedWorkspace?.id);

  // Get PR info from workspace summary (available immediately, no git calls needed)
  const summaryPr = useMemo(() => {
    if (!selectedWorkspace?.id) return undefined;
    const ws =
      activeWorkspaces.find((w) => w.id === selectedWorkspace.id) ??
      archivedWorkspaces.find((w) => w.id === selectedWorkspace.id);
    if (!ws?.prStatus || !ws.prNumber) return undefined;
    return {
      prNumber: ws.prNumber,
      prUrl: ws.prUrl,
      prStatus: ws.prStatus,
    };
  }, [selectedWorkspace?.id, activeWorkspaces, archivedWorkspaces]);

  const handleBranchNameChange = useCallback(
    (newName: string) => {
      renameBranch.mutate(newName);
    },
    [renameBranch]
  );

  // Transform repos to RepoInfo format (moved from WorkspacesLayout)
  // Uses workspace summary PR data as a fast fallback before branchStatus loads
  const repoInfos: RepoInfo[] = useMemo(
    () =>
      repos.map((repo) => {
        const repoStatus = branchStatus?.find((s) => s.repo_id === repo.id);

        let prNumber: number | undefined;
        let prUrl: string | undefined;
        let prStatus: 'open' | 'merged' | 'closed' | 'unknown' | undefined;

        if (repoStatus?.merges) {
          const openPR = repoStatus.merges.find(
            (m: Merge) => m.type === 'pr' && m.pr_info.status === 'open'
          );
          const mergedPR = repoStatus.merges.find(
            (m: Merge) => m.type === 'pr' && m.pr_info.status === 'merged'
          );

          const relevantPR = openPR || mergedPR;
          if (relevantPR && relevantPR.type === 'pr') {
            prNumber = Number(relevantPR.pr_info.number);
            prUrl = relevantPR.pr_info.url;
            prStatus = relevantPR.pr_info.status;
          }
        } else if (summaryPr) {
          // Use workspace summary PR data as a fast fallback while branchStatus loads.
          // The summary is fetched from the DB (no git calls) and is already cached.
          prNumber = summaryPr.prNumber;
          prUrl = summaryPr.prUrl;
          prStatus = summaryPr.prStatus;
        }

        return {
          id: repo.id,
          name: repo.display_name || repo.name,
          targetBranch: repo.target_branch || 'main',
          commitsAhead: repoStatus?.commits_ahead ?? 0,
          commitsBehind: repoStatus?.commits_behind ?? 0,
          remoteCommitsAhead: repoStatus?.remote_commits_ahead ?? 0,
          targetRemoteAhead: repoStatus?.target_remote_commits_ahead ?? 0,
          prNumber,
          prUrl,
          prStatus,
          // "Pull" only works when the work branch has an origin counterpart to
          // fast-forward from. The backend reports this directly (mirroring the
          // pull operation's own remote resolution), independent of any open PR —
          // so a pushed vk branch without a PR still shows Pull, while a local-only
          // branch never does.
          hasRemoteBranch: repoStatus?.work_branch_has_remote ?? false,
          hasUncommittedChanges: repoStatus?.has_uncommitted_changes ?? false,
        };
      }),
    [repos, branchStatus, summaryPr]
  );

  // Push state per repo lives in a background store keyed by workspace + repo,
  // so an in-flight push and its result feedback survive navigating away from
  // the git panel (component unmount) and keep running in the background.
  const pushStates =
    usePushBackground(selectedWorkspace?.id) ?? EMPTY_PUSH_STATES;
  const startPush = usePushBackgroundStore((s) => s.startPush);

  // Track target-branch push state per repo (push the base branch to origin).
  const [targetPushStates, setTargetPushStates] = useState<
    Record<string, PushState>
  >({});
  const targetPushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  // Reset target-push state when the selected workspace changes to avoid
  // leaking state across workspaces with repos that share the same ID. (Work-
  // branch push state lives in the workspace-keyed background store, so it needs
  // no reset here.)
  useEffect(() => {
    setTargetPushStates({});

    if (targetPushTimeoutRef.current) {
      clearTimeout(targetPushTimeoutRef.current);
      targetPushTimeoutRef.current = null;
    }
  }, [selectedWorkspace?.id]);

  // Clean up the target-push timeout on unmount.
  useEffect(() => {
    return () => {
      if (targetPushTimeoutRef.current) {
        clearTimeout(targetPushTimeoutRef.current);
      }
    };
  }, []);

  // Push the workspace's target (base) branch to origin. Handles the
  // force-push-required case by confirming, then retrying with force. Inline
  // state feedback mirrors the work-branch push button.
  const handleTargetPushClick = useCallback(
    async (repoId: string) => {
      const workspaceId = selectedWorkspace?.id;
      if (!workspaceId) return;
      if (targetPushStates[repoId] === 'pending') return;

      // Confirm before pushing the base branch to origin.
      const repoStatus = branchStatus?.find((s) => s.repo_id === repoId);
      const branch = repoStatus?.target_branch_name ?? '';
      const ahead = repoStatus?.target_remote_commits_ahead ?? 0;
      const confirmed = await ConfirmDialog.show({
        title: t('git.targetPush.title'),
        message: t('git.targetPush.confirm', { branch, ahead }),
        confirmText: t('git.states.push'),
      });
      if (confirmed !== 'confirmed') return;

      if (targetPushTimeoutRef.current) {
        clearTimeout(targetPushTimeoutRef.current);
        targetPushTimeoutRef.current = null;
      }
      setTargetPushStates((prev) => ({ ...prev, [repoId]: 'pending' }));

      try {
        let result = await workspacesApi.pushTargetBranch(
          workspaceId,
          repoId,
          false
        );

        if (!result.success && result.error?.type === 'force_push_required') {
          const confirm = await ConfirmDialog.show({
            title: t('git.states.forcePush'),
            message: t('git.targetPush.forceConfirm'),
            confirmText: t('git.states.forcePush'),
            variant: 'destructive',
          });
          if (confirm !== 'confirmed') {
            setTargetPushStates((prev) => ({ ...prev, [repoId]: 'idle' }));
            return;
          }
          result = await workspacesApi.pushTargetBranch(
            workspaceId,
            repoId,
            true
          );
        }

        if (!result.success) {
          throw new Error(result.message || 'Failed to push target branch');
        }

        setTargetPushStates((prev) => ({ ...prev, [repoId]: 'success' }));
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
        targetPushTimeoutRef.current = setTimeout(() => {
          setTargetPushStates((prev) => ({ ...prev, [repoId]: 'idle' }));
        }, 2000);
      } catch (err) {
        setTargetPushStates((prev) => ({ ...prev, [repoId]: 'error' }));
        const message =
          err instanceof Error ? err.message : 'Failed to push target branch';
        ConfirmDialog.show({
          title: 'Error',
          message,
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'destructive',
        });
        targetPushTimeoutRef.current = setTimeout(() => {
          setTargetPushStates((prev) => ({ ...prev, [repoId]: 'idle' }));
        }, 3000);
      }
    },
    [selectedWorkspace?.id, targetPushStates, branchStatus, queryClient, t]
  );

  // Compute repoInfos with push button state
  const repoInfosWithPushButton = useMemo(
    () =>
      repoInfos.map((repo) => {
        const state = pushStates[repo.id] ?? 'idle';
        const hasUnpushedCommits =
          repo.prStatus === 'open' && (repo.remoteCommitsAhead ?? 0) > 0;
        // Show push button if there are unpushed commits OR if we're in a push flow
        // (pending/success/error states keep the button visible for feedback)
        const isInPushFlow = state !== 'idle';

        // Target-branch push: show when the local target branch is ahead of
        // origin, or while a target push is in flight (for state feedback).
        const targetState = targetPushStates[repo.id] ?? 'idle';
        const targetAhead = repo.targetRemoteAhead ?? 0;
        const isInTargetPushFlow = targetState !== 'idle';
        return {
          ...repo,
          showPushButton: hasUnpushedCommits && !isInPushFlow,
          isPushPending: state === 'pending',
          isPushSuccess: state === 'success',
          isPushError: state === 'error',
          showTargetPushButton: targetAhead > 0 && !isInTargetPushFlow,
          targetPushAhead: targetAhead,
          isTargetPushPending: targetState === 'pending',
          isTargetPushSuccess: targetState === 'success',
          isTargetPushError: targetState === 'error',
        };
      }),
    [repoInfos, pushStates, targetPushStates]
  );

  // Handle opening command bar for repo actions
  const handleMoreClick = useCallback(
    (repoId: string) => {
      CommandBarDialog.show({
        page: 'repoActions',
        workspaceId: selectedWorkspace?.id,
        repoId,
      });
    },
    [selectedWorkspace?.id]
  );

  // Handle GitPanel actions using the action system
  const handleActionsClick = useCallback(
    async (repoId: string, action: RepoAction) => {
      if (!selectedWorkspace?.id) return;

      // Map RepoAction to Action definitions
      const actionMap = {
        commit: Actions.GitCommit,
        'pull-request': Actions.GitCreatePR,
        'link-pr': Actions.GitLinkPR,
        merge: Actions.GitMerge,
        rebase: Actions.GitRebase,
        'update-from-base': Actions.GitUpdateFromBase,
        pull: Actions.GitPull,
        'change-target': Actions.GitChangeTarget,
        push: Actions.GitPush,
      };

      const actionDef = actionMap[action];
      if (!actionDef) return;

      // Execute git action with workspaceId and repoId
      await executeAction(actionDef, selectedWorkspace.id, repoId);
    },
    [selectedWorkspace, executeAction]
  );

  // Handle push button click - delegate to the background store so the push and
  // its result feedback keep running even if this panel unmounts.
  const handlePushClick = useCallback(
    (repoId: string) => {
      const workspaceId = selectedWorkspace?.id;
      if (!workspaceId) return;
      startPush(workspaceId, repoId);
    },
    [selectedWorkspace?.id, startPush]
  );

  return (
    <GitPanel
      repos={repoInfosWithPushButton}
      repoSelectedActions={repoActions}
      workingBranchName={selectedWorkspace?.branch ?? ''}
      onWorkingBranchNameChange={handleBranchNameChange}
      onActionsClick={handleActionsClick}
      onRepoActionChange={setRepoAction}
      onPushClick={handlePushClick}
      onTargetPushClick={handleTargetPushClick}
      onMoreClick={handleMoreClick}
      onAddRepo={() => console.log('Add repo clicked')}
    />
  );
}
