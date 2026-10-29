import { describe, it, expect } from 'vitest';
import {
  buildNotificationTabUrl,
  bindNotificationRevisions,
  getPullRequestDetailsNavigationTarget,
  groupNotifications,
  isUserVisibleNotification,
  selectUnseenPullRequestCommentNotificationIds,
  selectUnseenNotificationIdsForView,
} from './notifications';
import type { GroupedNotification } from './notifications';
import type { Notification, NotificationPayload } from 'shared/remote-types';

function createNotification(
  overrides: Partial<Notification> = {}
): Notification {
  const payload: NotificationPayload = overrides.payload ?? {};
  return {
    id: 'n1',
    intent: 'legacy',
    routing_state: 'user',
    revision: 1,
    source_key: null,
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

it('binds dismissal to the observed revision and preserves an explicit older revision', () => {
  const updates = [
    { id: 'n1', changes: { seen: true } },
    { id: 'n2', changes: { archived: true, expected_revision: 1 } },
  ];
  expect(
    bindNotificationRevisions(updates, [
      createNotification({ revision: 2 }),
      createNotification({ id: 'n2', revision: 3 }),
    ])
  ).toEqual([
    { id: 'n1', changes: { seen: true, expected_revision: 2 } },
    { id: 'n2', changes: { archived: true, expected_revision: 1 } },
  ]);
});

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

describe('selectUnseenPullRequestCommentNotificationIds', () => {
  it('selects only unseen comment notifications for the viewed PR', () => {
    const notifications = [
      createNotification({
        id: 'matching',
        notification_type: 'pull_request_comment_added',
        payload: {
          pull_request_url: 'https://github.com/acme/repo/pull/42/',
        },
      }),
      createNotification({
        id: 'seen',
        notification_type: 'pull_request_comment_added',
        seen: true,
        payload: {
          pull_request_url: 'https://github.com/acme/repo/pull/42',
        },
      }),
      createNotification({
        id: 'other-pr',
        notification_type: 'pull_request_comment_added',
        payload: {
          pull_request_url: 'https://github.com/acme/repo/pull/43',
        },
      }),
      createNotification({
        id: 'issue-comment',
        notification_type: 'issue_comment_added',
        payload: {
          pull_request_url: 'https://github.com/acme/repo/pull/42',
        },
      }),
    ];

    expect(
      selectUnseenPullRequestCommentNotificationIds(
        notifications,
        'https://github.com/acme/repo/pull/42?tab=conversation'
      )
    ).toEqual(['matching']);
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

  it('ignores the legacy host payload', () => {
    expect(
      getPullRequestDetailsNavigationTarget(
        createNotification({
          notification_type: 'pull_request_comment_added',
          payload: {
            host_id: 'host-1',
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
});

describe('buildNotificationTabUrl', () => {
  function createGroup(
    latest: Notification,
    deeplinkPath: string | null = null
  ): GroupedNotification {
    return {
      id: latest.id,
      kind: 'single',
      latest,
      seen: false,
      deeplinkPath,
      notificationIds: [latest.id],
      notificationCount: 1,
      unseenNotificationIds: [latest.id],
      issueChangeCount: 0,
    };
  }

  it('returns the deeplink path for a plain notification', () => {
    const group = createGroup(createNotification(), '/projects/p1/issues/i1');
    expect(buildNotificationTabUrl(group)).toBe('/projects/p1/issues/i1');
  });

  it('opens the Drawer page on the note for a Drawer notification', () => {
    const group = createGroup(
      createNotification({ payload: { drawer_note_id: 'note-1' } }),
      '/notifications?drawer=note-1'
    );
    expect(buildNotificationTabUrl(group)).toBe('/drawer?note=note-1');
  });

  it('builds an account-scoped pull-requests URL from a legacy host payload', () => {
    const group = createGroup(
      createNotification({
        notification_type: 'pull_request_comment_added',
        payload: {
          host_id: 'host-1',
          pull_request_number: 42,
          pull_request_url: 'https://github.com/acme/repo/pull/42',
        },
      })
    );
    expect(buildNotificationTabUrl(group)).toBe(
      '/pull-requests?prUrl=https%3A%2F%2Fgithub.com%2Facme%2Frepo%2Fpull%2F42'
    );
  });

  it('falls back to the local pull-requests route without a host', () => {
    const group = createGroup(
      createNotification({
        notification_type: 'pull_request_comment_added',
        payload: {
          pull_request_number: 42,
          pull_request_url: 'https://github.com/acme/repo/pull/42',
        },
      })
    );
    expect(buildNotificationTabUrl(group)).toBe(
      '/pull-requests?prUrl=https%3A%2F%2Fgithub.com%2Facme%2Frepo%2Fpull%2F42'
    );
  });

  it('returns null when there is no navigation target', () => {
    const group = createGroup(createNotification(), null);
    expect(buildNotificationTabUrl(group)).toBeNull();
  });
});

describe('notification routing visibility', () => {
  it('filters held rows before grouping and preserves legacy and archive rows', () => {
    const rows = [
      createNotification({ id: 'user' }),
      createNotification({ id: 'pending', routing_state: 'autopilot_pending' }),
      createNotification({ id: 'claimed', routing_state: 'autopilot_claimed' }),
      createNotification({
        id: 'consumed',
        routing_state: 'autopilot_consumed',
        seen: true,
      }),
    ];
    expect(rows.filter(isUserVisibleNotification).map((n) => n.id)).toEqual([
      'user',
      'consumed',
    ]);
    expect(isUserVisibleNotification({})).toBe(true);
  });
});
