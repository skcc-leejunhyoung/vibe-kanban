import { describe, expect, it } from "vitest";
import {
  ActionTargetType,
  type ActionDefinition,
} from "@/shared/types/actions";
import { isRemoteExecutableAction } from "./remoteExecutableActions";

const action = (
  id: string,
  requiresTarget: ActionTargetType,
): ActionDefinition => ({ id, requiresTarget }) as unknown as ActionDefinition;

describe("isRemoteExecutableAction", () => {
  it.each([
    action("search-workspace-list", ActionTargetType.NONE),
    action("search-project-issues", ActionTargetType.NONE),
    action("toggle-workspace-archive-view", ActionTargetType.NONE),
  ])("allows $id", (action) => {
    expect(isRemoteExecutableAction(action)).toBe(true);
  });

  it.each([
    action("view-workspace-sessions", ActionTargetType.WORKSPACE),
    action("new-session", ActionTargetType.WORKSPACE),
    action("rename-session", ActionTargetType.WORKSPACE),
    action("delete-session", ActionTargetType.WORKSPACE),
    action("view-issue-workspaces", ActionTargetType.ISSUE),
  ])("rejects unsupported targeted action $id", (action) => {
    expect(isRemoteExecutableAction(action)).toBe(false);
  });
});
