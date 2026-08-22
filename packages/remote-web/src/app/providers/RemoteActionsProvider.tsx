import {
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Workspace } from "shared/types";
import {
  ActionsContext,
  type ActionsContextValue,
} from "@/shared/hooks/useActions";
import { UserContext } from "@/shared/hooks/useUserContext";
import {
  type ActionDefinition,
  type ActionExecutorContext,
  type ActionVisibilityContext,
  getActionLabel,
  resolveLabel,
  type ProjectMutations,
} from "@/shared/types/actions";
import { SettingsDialog } from "@/shared/dialogs/settings/SettingsDialog";
import { ConfirmDialog } from "@vibe/ui/components/ConfirmDialog";
import { useAppNavigation } from "@/shared/hooks/useAppNavigation";
import { useAppRuntime } from "@/shared/hooks/useAppRuntime";
import { useAuth } from "@/shared/hooks/auth/useAuth";
import { useOrganizationStore } from "@/shared/stores/useOrganizationStore";
import {
  buildKanbanIssueComposerKey,
  openKanbanIssueComposer,
  type ProjectIssueCreateOptions,
} from "@/shared/stores/useKanbanIssueComposerStore";
import {
  isRemoteExecutableAction,
  isRemoteExecutableGitAction,
  isRemoteExecutableIssueAction,
  isRemoteExecutableWorkspaceAction,
} from "./remoteExecutableActions";
import { getActivePaneActionExecutor } from "@/shared/lib/paneActionRegistry";

interface RemoteActionsProviderProps {
  children: ReactNode;
}

function noOpSelection(name: string) {
  console.warn(`[RemoteActionsProvider] ${name} is unavailable in remote web.`);
}

export function RemoteActionsProvider({
  children,
}: RemoteActionsProviderProps) {
  const appRuntime = useAppRuntime();
  const { userId } = useAuth();
  const appNavigation = useAppNavigation();
  const queryClient = useQueryClient();
  const { projectId, hostId } = useParams({ strict: false });
  const userCtx = useContext(UserContext);
  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);
  const [defaultCreateStatusId, setDefaultCreateStatusId] = useState<
    string | undefined
  >();
  const [projectMutations, setProjectMutations] =
    useState<ProjectMutations | null>(null);
  const [navigationProjects, setNavigationProjects] = useState<
    ActionExecutorContext["navigationProjects"]
  >([]);

  const registerProjectMutations = useCallback(
    (mutations: ProjectMutations): (() => void) => {
      setProjectMutations(mutations);
      // Only clear if this registration is still the active one, so a late
      // cleanup from a view unmounting after a route change can't wipe a newer
      // registration and leave issue actions without a project context.
      return () => {
        setProjectMutations((current) =>
          current === mutations ? null : current,
        );
      };
    },
    [],
  );

  const navigateToCreateIssue = useCallback(
    (options?: ProjectIssueCreateOptions) => {
      if (!projectId) return;
      openKanbanIssueComposer(
        buildKanbanIssueComposerKey(hostId ?? null, projectId),
        options,
      );
    },
    [hostId, projectId],
  );

  const openStatusSelection = useCallback(
    async (projectId: string, issueIds: string[]) => {
      const { ProjectSelectionDialog } = await import(
        "@/shared/dialogs/command-bar/selections/ProjectSelectionDialog"
      );
      await ProjectSelectionDialog.show({
        projectId,
        selection: { type: "status", issueIds },
      });
    },
    [],
  );

  const openPrioritySelection = useCallback(
    async (projectId: string, issueIds: string[]) => {
      const { ProjectSelectionDialog } = await import(
        "@/shared/dialogs/command-bar/selections/ProjectSelectionDialog"
      );
      await ProjectSelectionDialog.show({
        projectId,
        selection: { type: "priority", issueIds },
      });
    },
    [],
  );

  const openAssigneeSelection = useCallback(
    async (projectId: string, issueIds: string[], isCreateMode = false) => {
      const { AssigneeSelectionDialog } = await import(
        "@/shared/dialogs/kanban/AssigneeSelectionDialog"
      );
      await AssigneeSelectionDialog.show({ projectId, issueIds, isCreateMode });
    },
    [],
  );

  const openSubIssueSelection = useCallback(
    async (
      projectId: string,
      parentIssueId: string,
      mode: "addChild" | "setParent" = "addChild",
    ) => {
      const { ProjectSelectionDialog } = await import(
        "@/shared/dialogs/command-bar/selections/ProjectSelectionDialog"
      );
      return (await ProjectSelectionDialog.show({
        projectId,
        selection: { type: "subIssue", parentIssueId, mode },
      })) as { type: string } | undefined;
    },
    [],
  );

  const openWorkspaceSelection = useCallback(
    async (projectId: string, issueId: string) => {
      const { WorkspaceSelectionDialog } = await import(
        "@/shared/dialogs/command-bar/WorkspaceSelectionDialog"
      );
      await WorkspaceSelectionDialog.show({ projectId, issueId });
    },
    [],
  );

  const openRelationshipSelection = useCallback(
    async (
      projectId: string,
      issueId: string,
      relationshipType: "blocking" | "related" | "has_duplicate",
      direction: "forward" | "reverse",
    ) => {
      const { ProjectSelectionDialog } = await import(
        "@/shared/dialogs/command-bar/selections/ProjectSelectionDialog"
      );
      await ProjectSelectionDialog.show({
        projectId,
        selection: {
          type: "relationship",
          issueId,
          relationshipType,
          direction,
        },
      });
    },
    [],
  );

  const executorContext = useMemo<ActionExecutorContext>(
    () => ({
      appRuntime,
      userId,
      currentHostId: hostId ?? null,
      appNavigation,
      queryClient,
      selectWorkspace: () => {
        noOpSelection("Workspace actions");
      },
      activeWorkspaces: [],
      archivedWorkspaces: [],
      navigationProjects,
      currentWorkspaceId: null,
      currentSessionId: null,
      selectSession: () => {
        noOpSelection("Session actions");
      },
      startNewSession: () => {
        noOpSelection("Session actions");
      },
      containerRef: null,
      runningDevServers: [],
      startDevServer: () => {
        noOpSelection("Dev server actions");
      },
      stopDevServer: () => {
        noOpSelection("Dev server actions");
      },
      currentLogs: null,
      logsPanelContent: null,
      openStatusSelection,
      openPrioritySelection,
      openAssigneeSelection,
      openSubIssueSelection,
      openWorkspaceSelection,
      openRelationshipSelection,
      navigateToCreateIssue,
      defaultCreateStatusId,
      kanbanOrgId: selectedOrgId ?? undefined,
      kanbanProjectId: projectId,
      projectMutations: projectMutations ?? undefined,
      remoteWorkspaces: userCtx?.workspaces ?? [],
    }),
    [
      appRuntime,
      userId,
      hostId,
      queryClient,
      openStatusSelection,
      openPrioritySelection,
      openAssigneeSelection,
      openSubIssueSelection,
      openWorkspaceSelection,
      openRelationshipSelection,
      navigateToCreateIssue,
      defaultCreateStatusId,
      selectedOrgId,
      projectId,
      projectMutations,
      userCtx?.workspaces,
      navigationProjects,
    ],
  );

  const executeAction = useCallback(
    async (
      action: ActionDefinition,
      workspaceId?: string,
      _repoIdOrProjectId?: string,
      _issueIds?: string[],
      workspaceHostId?: string | null,
    ): Promise<void> => {
      const paneExecuteAction = getActivePaneActionExecutor();
      if (paneExecuteAction) {
        return paneExecuteAction(
          action,
          workspaceId,
          _repoIdOrProjectId,
          _issueIds,
          workspaceHostId,
        );
      }

      try {
        if (action.id === "settings") {
          await SettingsDialog.show({
            initialSection: "organizations",
          });
          return;
        }

        if (action.id === "project-settings") {
          await SettingsDialog.show({
            initialSection: "remote-projects",
            initialState: {
              organizationId: selectedOrgId ?? undefined,
              projectId: projectId ?? undefined,
            },
          });
          return;
        }

        if (isRemoteExecutableAction(action)) {
          await action.execute(executorContext);
          return;
        }

        if (isRemoteExecutableWorkspaceAction(action) && workspaceId) {
          await action.execute(executorContext, workspaceId, workspaceHostId);
          return;
        }

        if (
          isRemoteExecutableGitAction(action) &&
          workspaceId &&
          _repoIdOrProjectId
        ) {
          await action.execute(
            workspaceHostId === undefined
              ? executorContext
              : { ...executorContext, currentHostId: workspaceHostId },
            workspaceId,
            _repoIdOrProjectId,
          );
          return;
        }

        if (
          isRemoteExecutableIssueAction(action) &&
          _repoIdOrProjectId &&
          _issueIds?.length
        ) {
          await action.execute(executorContext, _repoIdOrProjectId, _issueIds);
          return;
        }

        console.warn(
          `[RemoteActionsProvider] Action "${action.id}" is unavailable in remote web.`,
        );
      } catch (error) {
        await ConfirmDialog.show({
          title: "Error",
          message: error instanceof Error ? error.message : "An error occurred",
          confirmText: "OK",
          showCancelButton: false,
          variant: "destructive",
        });
      }
    },
    [executorContext, projectId, selectedOrgId],
  );

  const getLabel = useCallback(
    (
      action: ActionDefinition,
      workspace?: Workspace,
      ctx?: ActionVisibilityContext,
    ) => {
      if (ctx) {
        return getActionLabel(action, ctx, workspace);
      }
      return resolveLabel(action, workspace);
    },
    [],
  );

  const value = useMemo<ActionsContextValue>(
    () => ({
      executeAction,
      getLabel,
      openStatusSelection,
      openPrioritySelection,
      openAssigneeSelection,
      openSubIssueSelection,
      openWorkspaceSelection,
      openRelationshipSelection,
      setDefaultCreateStatusId,
      registerProjectMutations,
      registerNavigationProjects: setNavigationProjects,
      executorContext,
    }),
    [
      executeAction,
      getLabel,
      openStatusSelection,
      openPrioritySelection,
      openAssigneeSelection,
      openSubIssueSelection,
      openWorkspaceSelection,
      openRelationshipSelection,
      registerProjectMutations,
      executorContext,
    ],
  );

  return (
    <ActionsContext.Provider value={value}>{children}</ActionsContext.Provider>
  );
}
