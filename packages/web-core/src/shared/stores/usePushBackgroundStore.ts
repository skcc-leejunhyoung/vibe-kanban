import { useCallback } from 'react';
import { create } from 'zustand';
import { workspacesApi } from '@/shared/lib/api';
import { queryClient } from '@/shared/lib/queryClient';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { ForcePushDialog } from '@/shared/dialogs/command-bar/ForcePushDialog';

/**
 * Background tracking for the work-branch git push so it survives the user
 * navigating away from the git panel. The push HTTP request is already fired
 * independently of any component, but its state feedback and post-processing
 * (branch-status refresh, force-push dialog, error dialog) used to live inside
 * GitPanelContainer and were lost when it unmounted — making a push look
 * "cancelled". Holding the state here, keyed by workspace + repo, keeps it
 * running in the background: come back to the panel and the pending/success/
 * error feedback is still there, and force-push/error dialogs surface even from
 * another screen.
 */

export type PushStatus = 'pending' | 'success' | 'error';

interface PushBackgroundState {
  // byWorkspace[workspaceId][repoId] -> current push status. Absence == idle.
  byWorkspace: Record<string, Record<string, PushStatus> | undefined>;
  startPush: (workspaceId: string, repoId: string) => void;
}

// Auto-clear timers (success/error → idle) live outside the reactive store,
// keyed by workspace+repo, so they survive the panel unmounting.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(workspaceId: string, repoId: string): string {
  return `${workspaceId}::${repoId}`;
}

export const usePushBackgroundStore = create<PushBackgroundState>()((
  set,
  get
) => {
  const setStatus = (workspaceId: string, repoId: string, status: PushStatus) =>
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: {
          ...state.byWorkspace[workspaceId],
          [repoId]: status,
        },
      },
    }));

  const clearStatus = (workspaceId: string, repoId: string) =>
    set((state) => {
      const repos = state.byWorkspace[workspaceId];
      if (!repos || !(repoId in repos)) return state;
      const nextRepos = { ...repos };
      delete nextRepos[repoId];
      const next = { ...state.byWorkspace };
      if (Object.keys(nextRepos).length === 0) {
        delete next[workspaceId];
      } else {
        next[workspaceId] = nextRepos;
      }
      return { byWorkspace: next };
    });

  const scheduleClear = (workspaceId: string, repoId: string, ms: number) => {
    const key = timerKey(workspaceId, repoId);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        clearStatus(workspaceId, repoId);
      }, ms)
    );
  };

  return {
    byWorkspace: {},

    startPush: (workspaceId, repoId) => {
      if (get().byWorkspace[workspaceId]?.[repoId] === 'pending') return;

      // Cancel any pending success/error auto-clear before starting.
      const key = timerKey(workspaceId, repoId);
      const existing = timers.get(key);
      if (existing) {
        clearTimeout(existing);
        timers.delete(key);
      }

      setStatus(workspaceId, repoId, 'pending');

      workspacesApi
        .push(workspaceId, { repo_id: repoId })
        .then(async (result) => {
          if (result.success) {
            // A push only affects remote status; refresh branch status.
            queryClient.invalidateQueries({
              queryKey: ['branchStatus', workspaceId],
            });
            setStatus(workspaceId, repoId, 'success');
            scheduleClear(workspaceId, repoId, 2000);
            return;
          }

          // Force push required → drop back to idle and prompt to confirm.
          if (result.error?.type === 'force_push_required') {
            clearStatus(workspaceId, repoId);
            await ForcePushDialog.show({ workspaceId, repoId });
            return;
          }

          setStatus(workspaceId, repoId, 'error');
          ConfirmDialog.show({
            title: 'Error',
            message: result.message || 'Failed to push changes',
            confirmText: 'OK',
            showCancelButton: false,
            variant: 'destructive',
          });
          scheduleClear(workspaceId, repoId, 3000);
        })
        .catch((err) => {
          console.error('Failed to push:', err);
          setStatus(workspaceId, repoId, 'error');
          const message =
            err instanceof Error ? err.message : 'Failed to push changes';
          ConfirmDialog.show({
            title: 'Error',
            message,
            confirmText: 'OK',
            showCancelButton: false,
            variant: 'destructive',
          });
          scheduleClear(workspaceId, repoId, 3000);
        });
    },
  };
});

// Subscribe to the push status map for a single workspace.
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
