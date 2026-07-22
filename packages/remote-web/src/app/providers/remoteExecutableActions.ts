import {
  ActionTargetType,
  type ActionDefinition,
  type GlobalActionDefinition,
} from "@/shared/types/actions";

const REMOTE_GLOBAL_ACTION_IDS = new Set([
  "goto-workspaces",
  "goto-projects",
  "search-workspace-list",
  "search-project-issues",
  "toggle-workspace-archive-view",
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
