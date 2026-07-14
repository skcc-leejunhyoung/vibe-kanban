import { useCallback } from 'react';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import type { CreateModeInitialState } from '@/shared/types/createMode';
import { persistWorkspaceCreateDraft } from '@/shared/lib/workspaceCreateState';

export function useProjectWorkspaceCreateDraft() {
  const { projectId } = useProjectContext();
  const appNavigation = useAppNavigation();
  const routeState = useCurrentKanbanRouteState();
  const runtime = useAppRuntime();

  const openWorkspaceCreateFromState = useCallback(
    async (
      initialState: CreateModeInitialState,
      options?: { issueId?: string | null; hostId?: string | null }
    ): Promise<string | null> => {
      if (!projectId) return null;

      const draftId = await persistWorkspaceCreateDraft(
        initialState,
        crypto.randomUUID(),
        runtime,
        options?.hostId
      );
      if (!draftId) {
        return null;
      }

      const issueId =
        options?.issueId ??
        initialState.linkedIssue?.issueId ??
        routeState.issueId ??
        null;
      if (issueId) {
        appNavigation.goToProjectIssueWorkspaceCreate(
          projectId,
          issueId,
          draftId,
          { hostId: options?.hostId }
        );
      } else {
        appNavigation.goToProjectWorkspaceCreate(projectId, draftId, {
          hostId: options?.hostId,
        });
      }

      return draftId;
    },
    [projectId, appNavigation, routeState.issueId, runtime]
  );

  return {
    openWorkspaceCreateFromState,
  };
}
