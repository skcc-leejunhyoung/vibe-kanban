import { useCallback } from 'react';
import { create } from 'zustand';
import { workspacesApi } from '@/shared/lib/api';
import { queryClient } from '@/shared/lib/queryClient';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { ForcePushDialog } from '@/shared/dialogs/command-bar/ForcePushDialog';
import { PullFirstDialog } from '@/shared/dialogs/command-bar/PullFirstDialog';
import { PushErrorDialog } from '@/shared/dialogs/command-bar/PushErrorDialog';
import i18n from '@/i18n/config';

/**
 * Background tracking for git pushes so their in-progress / result feedback
 * survives the user navigating away from the git panel. The push HTTP request
 * is fired independently of any component, but its state feedback and
 * post-processing (branch-status refresh, force-push dialog, error dialog) used
 * to live inside GitPanelContainer and were lost when it unmounted — making a
 * push look "cancelled". Holding the state here, keyed by workspace + repo,
 * keeps the pending/success/error indicator alive across navigation: come back
 * to the panel and it's still there, and dialogs surface even from another
 * screen.
 *
 * Two independent push flows are tracked:
 *  - work-branch push (`byWorkspace` / `startPush`)
 *  - target (base) branch push to origin (`targetByWorkspace` / `startTargetPush`)
 */

export type PushStatus = 'pending' | 'success' | 'error';

type PushField = 'byWorkspace' | 'targetByWorkspace';

interface PushBackgroundState {
  // byWorkspace[workspaceId][repoId] -> current status. Absence == idle.
  byWorkspace: Record<string, Record<string, PushStatus> | undefined>;
  targetByWorkspace: Record<string, Record<string, PushStatus> | undefined>;
  startPush: (workspaceId: string, repoId: string) => void;
  startTargetPush: (workspaceId: string, repoId: string) => void;
}

// Auto-clear timers (success/error → idle) live outside the reactive store,
// keyed by flow + workspace + repo, so they survive the panel unmounting.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(
  field: PushField,
  workspaceId: string,
  repoId: string
): string {
  return `${field}::${workspaceId}::${repoId}`;
}

export const usePushBackgroundStore = create<PushBackgroundState>()((
  set,
  get
) => {
  const setStatus = (
    field: PushField,
    workspaceId: string,
    repoId: string,
    status: PushStatus
  ) =>
    set((state) => ({
      [field]: {
        ...state[field],
        [workspaceId]: {
          ...state[field][workspaceId],
          [repoId]: status,
        },
      },
    }));

  const clearStatus = (field: PushField, workspaceId: string, repoId: string) =>
    set((state) => {
      const repos = state[field][workspaceId];
      if (!repos || !(repoId in repos)) return {};
      const nextRepos = { ...repos };
      delete nextRepos[repoId];
      const next = { ...state[field] };
      if (Object.keys(nextRepos).length === 0) {
        delete next[workspaceId];
      } else {
        next[workspaceId] = nextRepos;
      }
      return { [field]: next };
    });

  const scheduleClear = (
    field: PushField,
    workspaceId: string,
    repoId: string,
    ms: number
  ) => {
    const key = timerKey(field, workspaceId, repoId);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        clearStatus(field, workspaceId, repoId);
      }, ms)
    );
  };

  // Cancel any pending success/error auto-clear before (re)starting a flow.
  const cancelTimer = (
    field: PushField,
    workspaceId: string,
    repoId: string
  ) => {
    const key = timerKey(field, workspaceId, repoId);
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
      timers.delete(key);
    }
  };

  // Push errors carry the full git stderr/stdout; show it in a dedicated
  // dialog that renders the whole message with a copy button.
  const showErrorDialog = (message: string) =>
    PushErrorDialog.show({ message });

  return {
    byWorkspace: {},
    targetByWorkspace: {},

    startPush: (workspaceId, repoId) => {
      if (get().byWorkspace[workspaceId]?.[repoId] === 'pending') return;
      cancelTimer('byWorkspace', workspaceId, repoId);
      setStatus('byWorkspace', workspaceId, repoId, 'pending');

      workspacesApi
        .push(workspaceId, { repo_id: repoId })
        .then(async (result) => {
          if (result.success) {
            // A push only affects remote status; refresh branch status.
            queryClient.invalidateQueries({
              queryKey: ['branchStatus', workspaceId],
            });
            setStatus('byWorkspace', workspaceId, repoId, 'success');
            scheduleClear('byWorkspace', workspaceId, repoId, 2000);
            return;
          }

          // Diverged → the remote has commits we don't. Lead with the safe
          // pull-first resolution; only fall through to a force push if the user
          // explicitly asks (a bare force push would discard the remote commits).
          if (result.error?.type === 'diverged') {
            clearStatus('byWorkspace', workspaceId, repoId);
            const choice = await PullFirstDialog.show({
              workspaceId,
              repoId,
              ahead: result.error.ahead,
              behind: result.error.behind,
            });
            if (choice === 'force') {
              await ForcePushDialog.show({ workspaceId, repoId });
            }
            return;
          }

          // Force push required → drop back to idle and prompt to confirm.
          if (result.error?.type === 'force_push_required') {
            clearStatus('byWorkspace', workspaceId, repoId);
            await ForcePushDialog.show({ workspaceId, repoId });
            return;
          }

          setStatus('byWorkspace', workspaceId, repoId, 'error');
          showErrorDialog(result.message || 'Failed to push changes');
          scheduleClear('byWorkspace', workspaceId, repoId, 3000);
        })
        .catch((err) => {
          console.error('Failed to push:', err);
          setStatus('byWorkspace', workspaceId, repoId, 'error');
          showErrorDialog(
            err instanceof Error ? err.message : 'Failed to push changes'
          );
          scheduleClear('byWorkspace', workspaceId, repoId, 3000);
        });
    },

    // Push the workspace's target (base) branch to origin. The caller is
    // expected to have already confirmed the intent; this handles the
    // force-push-required retry and all result feedback in the background.
    startTargetPush: (workspaceId, repoId) => {
      if (get().targetByWorkspace[workspaceId]?.[repoId] === 'pending') return;
      cancelTimer('targetByWorkspace', workspaceId, repoId);
      setStatus('targetByWorkspace', workspaceId, repoId, 'pending');

      (async () => {
        try {
          let result = await workspacesApi.pushTargetBranch(
            workspaceId,
            repoId,
            false
          );

          // Diverged → lead with the safe pull-first flow (merge origin into the
          // target branch, then push). Force push stays available but only as an
          // explicit opt-in in the dialog — never the default.
          if (!result.success && result.error?.type === 'diverged') {
            clearStatus('targetByWorkspace', workspaceId, repoId);
            const choice = await PullFirstDialog.show({
              workspaceId,
              repoId,
              ahead: result.error.ahead,
              behind: result.error.behind,
              isTarget: true,
            });
            if (choice !== 'force') {
              // 'success' (dialog pulled & pushed), 'conflicts', or 'canceled':
              // the dialog and its hook already handled state + branchStatus.
              return;
            }
            // User explicitly chose to force-push instead.
            setStatus('targetByWorkspace', workspaceId, repoId, 'pending');
            result = await workspacesApi.pushTargetBranch(
              workspaceId,
              repoId,
              true
            );
          } else if (
            !result.success &&
            result.error?.type === 'force_push_required'
          ) {
            const confirm = await ConfirmDialog.show({
              title: i18n.t('tasks:git.states.forcePush'),
              message: i18n.t('tasks:git.targetPush.forceConfirm'),
              confirmText: i18n.t('tasks:git.states.forcePush'),
              variant: 'destructive',
            });
            if (confirm !== 'confirmed') {
              clearStatus('targetByWorkspace', workspaceId, repoId);
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

          setStatus('targetByWorkspace', workspaceId, repoId, 'success');
          queryClient.invalidateQueries({
            queryKey: ['branchStatus', workspaceId],
          });
          scheduleClear('targetByWorkspace', workspaceId, repoId, 2000);
        } catch (err) {
          setStatus('targetByWorkspace', workspaceId, repoId, 'error');
          showErrorDialog(
            err instanceof Error ? err.message : 'Failed to push target branch'
          );
          scheduleClear('targetByWorkspace', workspaceId, repoId, 3000);
        }
      })();
    },
  };
});

// Subscribe to the work-branch push status map for a single workspace.
export function usePushBackground(
  workspaceId: string | null | undefined
): Record<string, PushStatus> | undefined {
  return usePushBackgroundStore(
    useCallback(
      (state) => (workspaceId ? state.byWorkspace[workspaceId] : undefined),
      [workspaceId]
    )
  );
}

// Subscribe to the target (base) branch push status map for a single workspace.
export function useTargetPushBackground(
  workspaceId: string | null | undefined
): Record<string, PushStatus> | undefined {
  return usePushBackgroundStore(
    useCallback(
      (state) =>
        workspaceId ? state.targetByWorkspace[workspaceId] : undefined,
      [workspaceId]
    )
  );
}
