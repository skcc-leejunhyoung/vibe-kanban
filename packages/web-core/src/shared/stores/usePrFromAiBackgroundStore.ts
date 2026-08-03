import { useCallback } from 'react';
import { create } from 'zustand';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { workspacesApi } from '@/shared/lib/api';
import { queryClient } from '@/shared/lib/queryClient';
import { PushErrorDialog } from '@/shared/dialogs/command-bar/PushErrorDialog';
import i18n from '@/i18n/config';

/**
 * Background tracking for the "Create Pull Request from AI" command: a single
 * chained operation that (1) generates a PR title + description with the agent
 * and (2) opens a draft PR against the workspace's configured target branch.
 *
 * Modeled on {@link usePushBackgroundStore}: state is keyed by workspace + repo
 * so the in-progress / result feedback survives navigating away from the git
 * panel (component unmount) while the request keeps running. The command fires
 * this and returns immediately — there is no dialog. Outcomes surface as popups
 * (success / error) from here, and the git panel reads the status to render an
 * in-progress badge on the repo card.
 */

// generating -> creating are the two phases; success / error are terminal and
// auto-clear after a short delay. Absence == idle.
export type PrFromAiStatus = 'generating' | 'creating' | 'success' | 'error';

export interface PrFromAiOptions {
  // Base (target) branch to open the PR against. Null lets the backend fall back
  // to the repo's configured target branch.
  targetBranch: string | null;
  // Head (source) branch. Null lets the backend default to the work branch.
  headBranch: string | null;
  // The workspace's work branch, used to resolve a null head and to distinguish
  // a legacy PR record with no stored head from a PR on another feature branch.
  workBranch: string;
  hostId?: string | null;
}

interface PrFromAiBackgroundState {
  // byWorkspace[workspaceId][repoId] -> current status. Absence == idle.
  byWorkspace: Record<string, Record<string, PrFromAiStatus> | undefined>;
  startCreateFromAi: (
    workspaceId: string,
    repoId: string,
    opts: PrFromAiOptions
  ) => Promise<boolean>;
}

// How long the terminal success / error badge lingers before auto-clearing.
const SUCCESS_CLEAR_MS = 4000;
const ERROR_CLEAR_MS = 4000;

// Auto-clear timers (success/error -> idle) live outside the reactive store,
// keyed by workspace + repo, so they survive the panel unmounting.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(workspaceId: string, repoId: string): string {
  return `${workspaceId}::${repoId}`;
}

export const usePrFromAiBackgroundStore = create<PrFromAiBackgroundState>()((
  set,
  get
) => {
  const setStatus = (
    workspaceId: string,
    repoId: string,
    status: PrFromAiStatus
  ) =>
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
      if (!repos || !(repoId in repos)) return {};
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

  const cancelTimer = (workspaceId: string, repoId: string) => {
    const key = timerKey(workspaceId, repoId);
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
      timers.delete(key);
    }
  };

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

  // PR failures (agent generation errors, gh CLI not installed/logged in, etc.)
  // can carry multi-line output; show it in the dedicated scrollable dialog.
  const showErrorDialog = (message: string) =>
    PushErrorDialog.show({
      message,
      title: i18n.t('tasks:git.prFromAi.errorTitle'),
    });

  return {
    byWorkspace: {},

    startCreateFromAi: async (workspaceId, repoId, opts) => {
      const current = get().byWorkspace[workspaceId]?.[repoId];
      // Don't start a second run while one is already in flight for this repo.
      if (current === 'generating' || current === 'creating') return false;
      cancelTimer(workspaceId, repoId);
      setStatus(workspaceId, repoId, 'generating');

      try {
        // A PR for this exact head is a normal business condition, not an
        // AI-generation failure. Check it before starting the detached agent so
        // we neither spend a model response nor later surface the git-host's
        // duplicate-PR failure as a generic internal error. Other open PRs from
        // this workspace can target different feature branches and must not
        // block this one.
        const branchStatus = await workspacesApi.getBranchStatus(
          workspaceId,
          opts.hostId
        );
        const repoStatus = branchStatus.find(
          (status) => status.repo_id === repoId
        );
        const effectiveHead = opts.headBranch?.trim() || opts.workBranch;
        const existingPr = repoStatus?.merges.find(
          (merge) =>
            merge.type === 'pr' &&
            merge.pr_info.status === 'open' &&
            (merge.head_branch_name ?? opts.workBranch) === effectiveHead
        );
        if (existingPr?.type === 'pr') {
          clearStatus(workspaceId, repoId);
          showErrorDialog(
            i18n.t('tasks:git.prFromAi.prAlreadyExists', {
              number: existingPr.pr_info.number,
            })
          );
          return false;
        }
        // The branch-status endpoint has already calculated this against the
        // workspace target. It is only applicable when the work branch is the
        // PR head; a three-branch flow can instead use a feature branch.
        if (!opts.headBranch && repoStatus?.commits_ahead === 0) {
          clearStatus(workspaceId, repoId);
          showErrorDialog(i18n.t('tasks:git.prFromAi.noCommits'));
          return false;
        }

        // 1. Generate the PR title + description with the workspace's agent.
        const generated = await workspacesApi.generatePrDescription(
          workspaceId,
          {
            repo_id: repoId,
            target_branch: opts.targetBranch,
            head_branch: opts.headBranch,
            // Null reuses the workspace's most recently used agent config.
            executor_config: null,
          },
          undefined,
          opts.hostId
        );

        const title =
          generated.title?.trim() || i18n.t('tasks:git.prFromAi.fallbackTitle');

        // 2. Open the draft PR with the generated content.
        setStatus(workspaceId, repoId, 'creating');
        const result = await workspacesApi.createPR(
          workspaceId,
          {
            title,
            body: generated.description || null,
            target_branch: opts.targetBranch,
            head_branch: opts.headBranch,
            draft: true,
            repo_id: repoId,
          },
          undefined,
          opts.hostId
        );

        if (!result.success) {
          setStatus(workspaceId, repoId, 'error');
          scheduleClear(workspaceId, repoId, ERROR_CLEAR_MS);
          showErrorDialog(
            result.message || i18n.t('tasks:git.prFromAi.errorGeneric')
          );
          return false;
        }

        // The PR button / link is driven by the branch-status query. Refresh
        // it now so a PR created in the background is reflected immediately
        // instead of after the next poll.
        queryClient.invalidateQueries({
          queryKey: ['branchStatus', workspaceId],
        });
        setStatus(workspaceId, repoId, 'success');
        scheduleClear(workspaceId, repoId, SUCCESS_CLEAR_MS);

        // Completion popup — offer to open the new draft PR. The dialog button
        // click is a fresh user gesture, so opening the tab isn't popup-blocked.
        const prUrl = result.data;
        const choice = await ConfirmDialog.show({
          title: i18n.t('tasks:git.prFromAi.successTitle'),
          message: i18n.t('tasks:git.prFromAi.successMessage'),
          variant: 'success',
          confirmText: i18n.t('tasks:git.prFromAi.openPr'),
          cancelText: i18n.t('common:buttons.close'),
        });
        if (choice === 'confirmed' && prUrl) {
          openExternalUrl(prUrl);
        }
        return true;
      } catch (err) {
        setStatus(workspaceId, repoId, 'error');
        scheduleClear(workspaceId, repoId, ERROR_CLEAR_MS);
        showErrorDialog(
          err instanceof Error
            ? err.message
            : i18n.t('tasks:git.prFromAi.errorGeneric')
        );
        return false;
      }
    },
  };
});

// Subscribe to the AI-PR status map for a single workspace (repoId -> status).
export function usePrFromAiBackground(
  workspaceId: string | null | undefined
): Record<string, PrFromAiStatus> | undefined {
  return usePrFromAiBackgroundStore(
    useCallback(
      (state) => (workspaceId ? state.byWorkspace[workspaceId] : undefined),
      [workspaceId]
    )
  );
}
