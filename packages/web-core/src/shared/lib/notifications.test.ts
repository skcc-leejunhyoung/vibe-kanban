import { describe, it, expect } from 'vitest';
import {
  getPullRequestDetailsNavigationTarget,
  groupNotifications,
  selectUnseenNotificationIdsForView,
} from './notifications';
import type { Notification, NotificationPayload } from 'shared/remote-types';

function createNotification(
  overrides: Partial<Notification> = {}
): Notification {
  const payload: NotificationPayload = overrides.payload ?? {};
  return {
    id: 'n1',
    organization_id: 'org1',
    user_id: 'user1',
    notification_type: 'issue_comment_added',
    payload,
    issue_id: null,
    comment_id: null,
    seen: false,
    dismissed_at: null,
    created_at: '2026-06-18T00:00:00Z',
    ...overrides,
  };
}

describe('selectUnseenNotificationIdsForView', () => {
  it('returns ids of unseen notifications matching the viewed issue', () => {
    const notifications = [
      createNotification({ id: 'a', issue_id: 'issue-1' }),
      createNotification({ id: 'b', issue_id: 'issue-1' }),
      createNotification({ id: 'c', issue_id: 'issue-2' }),
    ];

    const ids = selectUnseenNotificationIdsForView(notifications, {
      issueId: 'issue-1',
      workspaceId: null,
    });

    expect(ids).toEqual(['a', 'b']);
  });

  it('excludes notifications that are already seen', () => {
    const notifications = [
      createNotification({ id: 'a', issue_id: 'issue-1', seen: true }),
      createNotification({ id: 'b', issue_id: 'issue-1', seen: false }),
    ];

    const ids = selectUnseenNotificationIdsForView(notifications, {
      issueId: 'issue-1',
      workspaceId: null,
    });

    expect(ids).toEqual(['b']);
  });

  it('matches workspace task notifications by payload.workspace_id', () => {
    const notifications = [
      createNotification({
        id: 'a',
        notification_type: 'workspace_task_completed',
        issue_id: null,
        payload: { workspace_id: 'ws-1' },
      }),
      createNotification({
        id: 'b',
        notification_type: 'workspace_task_completed',
        issue_id: null,
        payload: { workspace_id: 'ws-2' },
      }),
    ];

    const ids = selectUnseenNotificationIdsForView(notifications, {
      issueId: null,
      workspaceId: 'ws-1',
    });

    expect(ids).toEqual(['a']);
  });

  it('matches a workspace notification linked to the viewed issue via issue_id', () => {
    const notifications = [
      createNotification({
        id: 'a',
        notification_type: 'workspace_task_completed',
        issue_id: 'issue-1',
        payload: { workspace_id: 'ws-1' },
      }),
    ];

    const ids = selectUnseenNotificationIdsForView(notifications, {
      issueId: 'issue-1',
      workspaceId: null,
    });

    expect(ids).toEqual(['a']);
  });

  it('returns an empty array when no view target is provided', () => {
    const notifications = [
      createNotification({ id: 'a', issue_id: 'issue-1' }),
    ];

    const ids = selectUnseenNotificationIdsForView(notifications, {
      issueId: null,
      workspaceId: null,
    });

    expect(ids).toEqual([]);
  });

  it('does not match notifications unrelated to the viewed target', () => {
    const notifications = [
      createNotification({ id: 'a', issue_id: 'issue-99' }),
      createNotification({
        id: 'b',
        issue_id: null,
        payload: { workspace_id: 'ws-99' },
      }),
    ];

    const ids = selectUnseenNotificationIdsForView(notifications, {
      issueId: 'issue-1',
      workspaceId: 'ws-1',
    });

    expect(ids).toEqual([]);
  });

  it('does not double-count a notification matching both issue and workspace', () => {
    const notifications = [
      createNotification({
        id: 'a',
        issue_id: 'issue-1',
        payload: { workspace_id: 'ws-1' },
      }),
    ];

    const ids = selectUnseenNotificationIdsForView(notifications, {
      issueId: 'issue-1',
      workspaceId: 'ws-1',
    });

    expect(ids).toEqual(['a']);
  });
});

describe('groupNotifications', () => {
  it('keeps an unmapped PR comment notification clickable as a single item', () => {
    const [group] = groupNotifications([
      createNotification({
        notification_type: 'pull_request_comment_added',
        payload: {
          pull_request_number: 42,
          pull_request_url: 'https://github.com/acme/repo/pull/42',
        },
      }),
    ]);

    expect(group.kind).toBe('single');
    expect(group.deeplinkPath).toBeNull();
    expect(group.latest.payload.pull_request_number).toBe(42);
  });
});

describe('getPullRequestDetailsNavigationTarget', () => {
  it('returns the exact PR referenced by a PR comment notification', () => {
    expect(
      getPullRequestDetailsNavigationTarget(
        createNotification({
          notification_type: 'pull_request_comment_added',
          payload: {
            deeplink_path: '/projects/project-1/issues/issue-1',
            pull_request_number: 42,
            pull_request_url: 'https://github.com/acme/repo/pull/42',
          },
        })
      )
    ).toEqual({
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42',
    });
  });

  it('does not open a PR dialog for notifications without a complete PR target', () => {
    expect(
      getPullRequestDetailsNavigationTarget(
        createNotification({
          notification_type: 'pull_request_comment_added',
          payload: { pull_request_url: 'https://github.com/acme/repo/pull/42' },
        })
      )
    ).toBeNull();
    expect(
      getPullRequestDetailsNavigationTarget(createNotification())
    ).toBeNull();
  });
});
