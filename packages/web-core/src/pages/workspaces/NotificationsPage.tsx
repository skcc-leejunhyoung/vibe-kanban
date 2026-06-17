import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  BellIcon,
  BellRingingIcon,
  CheckIcon,
  ChecksIcon,
} from '@phosphor-icons/react';
import { Checkbox } from '@vibe/ui/components/Checkbox';
import { Switch } from '@vibe/ui/components/Switch';
import { UserAvatar } from '@vibe/ui/components/UserAvatar';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useNotifications } from '@/shared/hooks/useNotifications';
import { useNotificationMembers } from '@/shared/hooks/useNotificationMembers';
import type { GroupedNotification } from '@/shared/lib/notifications';
import {
  getGroupedNotificationSegments,
  type MessageSegment,
} from '@/shared/lib/notificationMessage';
import { formatRelativeTime } from '@/shared/lib/date';
import { cn } from '@/shared/lib/utils';
import {
  disableWebPush,
  enableWebPush,
  getWebPushStatus,
  type WebPushStatus,
} from '@/shared/lib/webPush';

function NotificationMessage({
  segments,
  membersByUserId,
}: {
  segments: MessageSegment[];
  membersByUserId: ReturnType<typeof useNotificationMembers>['membersByUserId'];
}) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.value}</span>;
        if (seg.type === 'emphasis') {
          return (
            <span key={i} className="font-medium text-high">
              {seg.value}
            </span>
          );
        }
        if (seg.type === 'issue') {
          return (
            <span
              key={i}
              className="font-ibm-plex-mono text-high text-[0.95em]"
            >
              {seg.value}
            </span>
          );
        }
        const member = membersByUserId.get(seg.userId);
        if (member) {
          return (
            <UserAvatar
              key={i}
              user={member}
              className="inline-flex h-5 w-5 align-text-bottom text-[10px]"
            />
          );
        }
        return <span key={i}>Someone</span>;
      })}
    </>
  );
}

function WebPushToggle() {
  const runtime = useAppRuntime();
  const [status, setStatus] = useState<WebPushStatus>('unsupported');
  const [pending, setPending] = useState(false);

  const refresh = useCallback(() => {
    void getWebPushStatus(runtime)
      .then(setStatus)
      .catch(() => {
        setStatus('disabled');
      });
  }, [runtime]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleClick = useCallback(async () => {
    if (pending || status === 'unsupported' || status === 'disabled') return;

    setPending(true);
    try {
      if (status === 'subscribed') {
        await disableWebPush(runtime);
      } else {
        await enableWebPush(runtime);
      }
      refresh();
    } catch {
      refresh();
    } finally {
      setPending(false);
    }
  }, [pending, refresh, runtime, status]);

  const checked = status === 'subscribed';
  const disabled =
    pending ||
    status === 'unsupported' ||
    status === 'disabled' ||
    status === 'denied';
  const label =
    status === 'subscribed'
      ? 'Push on'
      : status === 'denied'
        ? 'Push blocked'
        : status === 'unsupported'
          ? 'Push unavailable'
          : status === 'disabled'
            ? 'Push disabled'
            : 'Enable push';

  return (
    <div
      className={cn(
        'flex items-center gap-half px-base py-half text-sm text-low',
        disabled && 'opacity-50'
      )}
      title={label}
    >
      <BellRingingIcon size={16} />
      <span className="hidden sm:inline">{pending ? 'Saving...' : label}</span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={handleClick}
        aria-label={label}
      />
    </div>
  );
}

export function NotificationsPage() {
  const router = useRouter();
  const {
    data,
    activeNotifications,
    updateMany,
    enabled,
    unseenCount,
    groupedNotifications,
    groupedArchivedNotifications,
  } = useNotifications();
  const [view, setView] = useState<'inbox' | 'archive'>('inbox');
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    () => new Set()
  );
  const visibleGroups =
    view === 'archive' ? groupedArchivedNotifications : groupedNotifications;
  const selectedGroups = useMemo(
    () => visibleGroups.filter((group) => selectedGroupIds.has(group.id)),
    [selectedGroupIds, visibleGroups]
  );
  const selectedNotificationIds = useMemo(
    () =>
      Array.from(
        new Set(selectedGroups.flatMap((group) => group.notificationIds))
      ),
    [selectedGroups]
  );
  const selectedCount = selectedGroups.length;
  const { membersByUserId } = useNotificationMembers(data);

  const markGroupSeen = useCallback(
    (group: GroupedNotification) => {
      if (group.unseenNotificationIds.length === 0) {
        return;
      }

      updateMany(
        group.unseenNotificationIds.map((notificationId) => ({
          id: notificationId,
          changes: { seen: true },
        }))
      );
    },
    [updateMany]
  );

  useEffect(() => {
    setSelectedGroupIds(new Set());
  }, [view]);

  const toggleGroupSelected = useCallback(
    (groupId: string, selected: boolean) => {
      setSelectedGroupIds((current) => {
        const next = new Set(current);
        if (selected) {
          next.add(groupId);
        } else {
          next.delete(groupId);
        }
        return next;
      });
    },
    []
  );

  const allVisibleSelected =
    visibleGroups.length > 0 &&
    visibleGroups.every((group) => selectedGroupIds.has(group.id));

  const toggleSelectAll = useCallback(() => {
    setSelectedGroupIds((current) => {
      if (
        visibleGroups.length > 0 &&
        visibleGroups.every((group) => current.has(group.id))
      ) {
        return new Set();
      }

      return new Set(visibleGroups.map((group) => group.id));
    });
  }, [visibleGroups]);

  const updateSelectedSeen = useCallback(
    (seen: boolean) => {
      if (selectedNotificationIds.length === 0) return;
      updateMany(
        selectedNotificationIds.map((id) => ({
          id,
          changes: { seen },
        }))
      );
      setSelectedGroupIds(new Set());
    },
    [selectedNotificationIds, updateMany]
  );

  const handleClick = useCallback(
    (group: GroupedNotification) => {
      markGroupSeen(group);
      const path = group.deeplinkPath;
      if (path) {
        router.navigate({ to: path as '/' });
      }
    },
    [markGroupSeen, router]
  );

  const handleMarkAllSeen = useCallback(() => {
    const unseen = activeNotifications.filter((n) => !n.seen);
    if (unseen.length === 0) return;
    updateMany(unseen.map((n) => ({ id: n.id, changes: { seen: true } })));
  }, [activeNotifications, updateMany]);

  if (!enabled) {
    return (
      <div className="flex items-center justify-center h-full text-low">
        Sign in to view notifications
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-double py-base border-b border-border">
        <div className="flex items-center gap-half min-w-0">
          <button
            type="button"
            onClick={() => router.history.back()}
            className={cn(
              'flex sm:hidden items-center justify-center rounded-sm p-half text-low transition-colors',
              'hover:bg-secondary hover:text-normal',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand'
            )}
            aria-label="Go back"
            title="Back"
          >
            <ArrowLeftIcon size={18} />
          </button>
          <h1 className="text-xl font-medium text-high truncate">
            Notifications
          </h1>
        </div>
        <div className="flex items-center gap-half">
          <WebPushToggle />
          {view === 'inbox' && unseenCount > 0 && selectedCount === 0 && (
            <button
              type="button"
              onClick={handleMarkAllSeen}
              className="flex items-center gap-1 px-base py-half text-sm text-low hover:text-normal transition-colors cursor-pointer"
            >
              <ChecksIcon size={16} />
              Mark all as read
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-base px-double py-half border-b border-border">
        <div className="flex items-center gap-half">
          {(['inbox', 'archive'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setView(tab)}
              className={cn(
                'px-base py-half rounded-sm text-sm transition-colors cursor-pointer',
                view === tab
                  ? 'bg-secondary text-high'
                  : 'text-low hover:text-normal hover:bg-secondary'
              )}
            >
              {tab === 'inbox' ? 'Inbox' : 'Archive'}
            </button>
          ))}
        </div>

        {visibleGroups.length > 0 && (
          <div className="flex items-center gap-half text-sm text-low">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={toggleSelectAll}
              aria-label="Select all notifications"
            />
            {selectedCount > 0 ? (
              <>
                <span className="hidden sm:inline">
                  {selectedCount} selected
                </span>
                <button
                  type="button"
                  onClick={() => updateSelectedSeen(true)}
                  className="px-half py-half rounded-sm hover:bg-secondary hover:text-normal transition-colors cursor-pointer"
                >
                  Mark read
                </button>
                <button
                  type="button"
                  onClick={() => updateSelectedSeen(false)}
                  className="px-half py-half rounded-sm hover:bg-secondary hover:text-normal transition-colors cursor-pointer"
                >
                  Mark unread
                </button>
              </>
            ) : (
              <span className="hidden sm:inline">Select</span>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {visibleGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-low">
            <BellIcon size={32} weight="light" />
            <p className="text-base">
              {view === 'archive'
                ? 'No archived notifications'
                : 'No notifications yet'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visibleGroups.map((group) => (
              <div
                key={group.id}
                role="button"
                tabIndex={0}
                onClick={() => handleClick(group)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleClick(group);
                  }
                }}
                className={cn(
                  'w-full flex items-center gap-base px-double py-base text-left transition-colors cursor-pointer outline-none',
                  'hover:bg-secondary',
                  'focus-visible:bg-secondary',
                  'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand',
                  !group.seen && 'bg-brand/5'
                )}
              >
                <Checkbox
                  checked={selectedGroupIds.has(group.id)}
                  onClick={(e) => e.stopPropagation()}
                  onCheckedChange={(checked) =>
                    toggleGroupSelected(group.id, checked)
                  }
                  className="shrink-0"
                  aria-label="Select notification"
                />
                <span
                  className={cn(
                    'shrink-0 w-2 h-2 rounded-full',
                    !group.seen && 'bg-brand'
                  )}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      'text-base truncate',
                      group.seen ? 'text-normal' : 'text-high'
                    )}
                  >
                    <NotificationMessage
                      segments={getGroupedNotificationSegments(group)}
                      membersByUserId={membersByUserId}
                    />
                  </p>
                  <p className="text-sm text-low mt-0.5">
                    {formatRelativeTime(group.latest.created_at)}
                  </p>
                </div>
                {!group.seen && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      markGroupSeen(group);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className={cn(
                      'shrink-0 inline-flex items-center gap-half rounded-sm px-half py-half text-sm text-low transition-colors cursor-pointer',
                      'hover:bg-secondary hover:text-normal',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand'
                    )}
                    aria-label="Mark notification as read"
                    title="Mark as read"
                  >
                    <CheckIcon size={14} weight="bold" />
                    <span className="hidden sm:inline">Mark as read</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
