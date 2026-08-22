import {
  ActionTargetType,
  type ActionDefinition,
  type GlobalActionDefinition,
  type IssueActionDefinition,
  type WorkspaceActionDefinition,
} from "@/shared/types/actions";

export function isRemoteExecutableAction(
  action: ActionDefinition,
): action is GlobalActionDefinition {
  return action.requiresTarget === ActionTargetType.NONE;
}

export function isRemoteExecutableWorkspaceAction(
  action: ActionDefinition,
): action is WorkspaceActionDefinition {
  return action.requiresTarget === ActionTargetType.WORKSPACE;
}

export function isRemoteExecutableGitAction(
  action: ActionDefinition,
): action is Extract<
  ActionDefinition,
  { requiresTarget: ActionTargetType.GIT }
> {
  return action.requiresTarget === ActionTargetType.GIT;
}

export function isRemoteExecutableIssueAction(
  action: ActionDefinition,
): action is IssueActionDefinition {
  return action.requiresTarget === ActionTargetType.ISSUE;
}
