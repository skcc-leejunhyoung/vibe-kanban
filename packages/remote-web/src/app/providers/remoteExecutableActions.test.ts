import { describe, expect, it } from "vitest";
import {
  ActionTargetType,
  type ActionDefinition,
} from "@/shared/types/actions";
import {
  isRemoteExecutableAction,
  isRemoteExecutableGitAction,
  isRemoteExecutableIssueAction,
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
    action("goto-notifications", ActionTargetType.NONE),
    action("goto-url", ActionTargetType.NONE),
    action("new-workspace", ActionTargetType.NONE),
    action("quick-chat", ActionTargetType.NONE),
    action("toggle-app-bar", ActionTargetType.NONE),
    action("toggle-right-sidebar", ActionTargetType.NONE),
    action("toggle-changes-mode", ActionTargetType.NONE),
    action("toggle-logs-mode", ActionTargetType.NONE),
    action("toggle-preview-mode", ActionTargetType.NONE),
    action("create-issue", ActionTargetType.NONE),
    action("change-new-issue-status", ActionTargetType.NONE),
    action("change-new-issue-priority", ActionTargetType.NONE),
    action("change-new-issue-assignees", ActionTargetType.NONE),
    action("add-bookmark", ActionTargetType.NONE),
    action("remove-bookmark", ActionTargetType.NONE),
    action("newPane", ActionTargetType.NONE),
    action("closePane", ActionTargetType.NONE),
    action("focusPane1", ActionTargetType.NONE),
    action("open-bookmark-0", ActionTargetType.NONE),
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

describe("isRemoteExecutableIssueAction", () => {
  it("allows issue actions and rejects other targets", () => {
    expect(
      isRemoteExecutableIssueAction(
        action("delete-issue", ActionTargetType.ISSUE),
      ),
    ).toBe(true);
    expect(
      isRemoteExecutableIssueAction(
        action("delete-issue", ActionTargetType.WORKSPACE),
      ),
    ).toBe(false);
  });
});

describe("isRemoteExecutableGitAction", () => {
  it.each([
    "git-commit",
    "git-create-pr",
    "git-create-pr-from-ai",
    "git-open-pr",
    "git-open-pr-in-pull-requests",
    "git-view-pr-details",
    "git-link-pr",
    "git-link-pr-by-url",
    "git-unlink-pr",
    "git-merge",
    "git-pull",
    "git-update-from-base",
    "git-update-target-from-base",
    "git-push",
    "git-fetch-target",
    "git-push-target",
    "git-rebase",
    "git-change-target",
    "repo-copy-path",
    "repo-open-in-ide",
    "repo-settings",
  ])("allows %s", (id) => {
    expect(isRemoteExecutableGitAction(action(id, ActionTargetType.GIT))).toBe(
      true,
    );
  });

  it("rejects unsupported or incorrectly targeted actions", () => {
    expect(
      isRemoteExecutableGitAction(
        action("git-commit", ActionTargetType.WORKSPACE),
      ),
    ).toBe(false);
    expect(
      isRemoteExecutableGitAction(action("future-git", ActionTargetType.GIT)),
    ).toBe(true);
  });
});

describe("isRemoteExecutableWorkspaceAction", () => {
  it.each([
    action("open-workspace", ActionTargetType.WORKSPACE),
    action("open-workspace-in-new-tab", ActionTargetType.WORKSPACE),
    action("archive-workspace", ActionTargetType.WORKSPACE),
    action("delete-workspace", ActionTargetType.WORKSPACE),
    action("view-workspace-sessions", ActionTargetType.WORKSPACE),
    action("new-session", ActionTargetType.WORKSPACE),
  ])("allows $id", (action) => {
    expect(isRemoteExecutableWorkspaceAction(action)).toBe(true);
  });

  it.each([
    action("open-workspace", ActionTargetType.NONE),
    action("delete-workspace", ActionTargetType.GIT),
  ])("rejects incorrectly targeted action $id", (action) => {
    expect(isRemoteExecutableWorkspaceAction(action)).toBe(false);
  });
});
