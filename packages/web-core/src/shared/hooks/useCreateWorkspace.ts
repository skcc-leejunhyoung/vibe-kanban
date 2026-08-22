import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type {
  CreateAndStartWorkspaceRequest,
  CreateWorkspaceWithoutStartingRequest,
  Workspace,
} from 'shared/types';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { useHostId } from '@/shared/providers/HostIdProvider';

interface LinkToIssueParams {
  remoteProjectId: string;
  issueId: string;
}

interface CreateAndStartWorkspaceParams {
  data: CreateAndStartWorkspaceRequest;
  linkToIssue?: LinkToIssueParams;
}

interface CreateWorkspaceOnlyParams {
  data: CreateWorkspaceWithoutStartingRequest;
  linkToIssue?: LinkToIssueParams;
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  const hostId = useHostId();

  const finishWorkspaceCreation = async (
    workspace: Workspace,
    linkToIssue?: LinkToIssueParams
  ) => {
    if (linkToIssue) {
      try {
        await workspacesApi.linkToIssue(
          workspace.id,
          linkToIssue.remoteProjectId,
          linkToIssue.issueId,
          hostId
        );
      } catch (linkError) {
        console.error('Failed to link workspace to issue:', linkError);
      }
    }

    return { workspace };
  };

  const createWorkspace = useMutation({
    mutationFn: async ({
      data,
      linkToIssue,
    }: CreateAndStartWorkspaceParams) => {
      const { workspace } = await workspacesApi.createAndStart(data, hostId);
      return finishWorkspaceCreation(workspace, linkToIssue);
    },
    onSuccess: () => {
      // Invalidate workspace summaries so they refresh with the new workspace included
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      // Ensure create-mode defaults refetch the latest session/model selection.
      queryClient.invalidateQueries({ queryKey: ['workspaceCreateDefaults'] });
    },
    onError: (err) => {
      console.error('Failed to create workspace:', err);
    },
  });

  const createWorkspaceOnly = useMutation({
    mutationFn: async ({ data, linkToIssue }: CreateWorkspaceOnlyParams) => {
      const { workspace } = await workspacesApi.createOnly(data, hostId);
      return finishWorkspaceCreation(workspace, linkToIssue);
    },
    onSuccess: () => {
      // Invalidate workspace summaries so they refresh with the new workspace included
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      // Ensure create-mode defaults refetch the latest session/model selection.
      queryClient.invalidateQueries({ queryKey: ['workspaceCreateDefaults'] });
    },
    onError: (err) => {
      console.error('Failed to create workspace:', err);
    },
  });

  return { createWorkspace, createWorkspaceOnly };
}
