import { describe, expect, it } from "vitest";
import {
  ActionTargetType,
  type ActionDefinition,
} from "@/shared/types/actions";
import {
  isRemoteExecutableAction,
  isRemoteExecutableWorkspaceAction,
} from "./remoteExecutableActions";

const action = (
  id: string,
  requiresTarget: ActionTargetType,
): ActionDefinition => ({ id, requiresTarget }) as unknown as ActionDefinition;

describe("isRemoteExecutableAction", () => {
  it.each([
    action("search-workspace-list", ActionTargetType.NONE),
    action("search-project-issues", ActionTargetType.NONE),
    action("toggle-workspace-archive-view", ActionTargetType.NONE),
    action("goto-url", ActionTargetType.NONE),
    action("goto-pull-requests", ActionTargetType.NONE),
    action("filter-pull-requests", ActionTargetType.NONE),
    action("select-pull-requests-repository", ActionTargetType.NONE),
    action("search-pull-requests", ActionTargetType.NONE),
    action("goto-pull-request-mapped-issue", ActionTargetType.NONE),
    action("view-pull-request-mapped-workspaces", ActionTargetType.NONE),
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

describe("isRemoteExecutableWorkspaceAction", () => {
  it.each([
    action("open-workspace", ActionTargetType.WORKSPACE),
    action("open-workspace-in-new-tab", ActionTargetType.WORKSPACE),
  ])("allows $id", (action) => {
    expect(isRemoteExecutableWorkspaceAction(action)).toBe(true);
  });

  it.each([
    action("open-workspace", ActionTargetType.NONE),
    action("view-workspace-sessions", ActionTargetType.WORKSPACE),
    action("new-session", ActionTargetType.WORKSPACE),
  ])("rejects unsupported or incorrectly targeted action $id", (action) => {
    expect(isRemoteExecutableWorkspaceAction(action)).toBe(false);
  });
});
