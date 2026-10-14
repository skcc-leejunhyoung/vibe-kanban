import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type {
  CreateAndStartWorkspaceRequest,
  CreateWorkspaceWithoutStartingRequest,
  Session,
  Workspace,
} from 'shared/types';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { selectWorkspaceSession } from '@/shared/hooks/useWorkspaceSessions';
import { seedOptimisticProcess } from '@/shared/providers/executionProcessScope';
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

  const finishWorkspaceCreation = (
    workspace: Workspace,
    linkToIssue?: LinkToIssueParams
  ) => {
    // Best-effort cloud link (failures are only logged): don't hold the jump
    // into the new workspace on that round trip.
    if (linkToIssue) {
      void workspacesApi
        .linkToIssue(
          workspace.id,
          linkToIssue.remoteProjectId,
          linkToIssue.issueId,
          hostId
        )
        .catch((linkError) => {
          console.error('Failed to link workspace to issue:', linkError);
        });
    }

    return { workspace };
  };

  const createWorkspace = useMutation({
    mutationFn: async ({
      data,
      linkToIssue,
    }: CreateAndStartWorkspaceParams) => {
      const { workspace, session, execution_process } =
        await workspacesApi.createAndStart(data, hostId);
      // The server answers as soon as the session and its first process exist
      // (worktree and agent spawn continue in the background). Open straight
      // into that session with the turn already on screen instead of waiting
      // for the sessions fetch and the first stream replay.
      if (session) {
        queryClient.setQueryData<Session[]>(
          workspaceSessionKeys.byWorkspace(workspace.id, hostId),
          [session]
        );
        selectWorkspaceSession(workspace.id, hostId, session.id);
      }
      seedOptimisticProcess(execution_process);
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
