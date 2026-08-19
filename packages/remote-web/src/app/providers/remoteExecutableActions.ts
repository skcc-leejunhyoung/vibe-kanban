import {
  ActionTargetType,
  type ActionDefinition,
  type GlobalActionDefinition,
  type WorkspaceActionDefinition,
} from "@/shared/types/actions";

const REMOTE_GLOBAL_ACTION_IDS = new Set([
  "goto-workspaces",
  "goto-projects",
  "goto-url",
  "goto-pull-requests",
  "filter-pull-requests",
  "select-pull-requests-repository",
  "search-pull-requests",
  "goto-pull-request-mapped-issue",
  "view-pull-request-mapped-workspaces",
  "search-workspace-list",
  "search-project-issues",
  "toggle-workspace-archive-view",
]);

const REMOTE_WORKSPACE_ACTION_IDS = new Set([
  "open-workspace",
  "open-workspace-in-new-tab",
]);

export function isRemoteExecutableAction(
  action: ActionDefinition,
): action is GlobalActionDefinition {
  return (
    action.requiresTarget === ActionTargetType.NONE &&
    (REMOTE_GLOBAL_ACTION_IDS.has(action.id) ||
      action.id.startsWith("goto-project-") ||
      action.id.startsWith("goto-workspace-"))
  );
}

export function isRemoteExecutableWorkspaceAction(
  action: ActionDefinition,
): action is WorkspaceActionDefinition {
  return (
    action.requiresTarget === ActionTargetType.WORKSPACE &&
    REMOTE_WORKSPACE_ACTION_IDS.has(action.id)
  );
}
