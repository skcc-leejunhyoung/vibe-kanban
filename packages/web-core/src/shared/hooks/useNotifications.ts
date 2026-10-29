import { useCallback, useMemo } from 'react';
import {
  bindNotificationRevisions,
  isUserVisibleNotification,
} from '@/shared/lib/notifications';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  NOTIFICATIONS_SHAPE,
  NOTIFICATION_MUTATION,
} from 'shared/remote-types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { groupNotifications } from '@/shared/lib/notifications';
import {
  collectDismissiblePushIds,
  dismissDeliveredPushNotifications,
} from '@/shared/lib/webPush';

export function useNotifications() {
  const { isSignedIn, userId } = useAuth();

  const enabled = isSignedIn && !!userId;

  const result = useShape(
    NOTIFICATIONS_SHAPE,
    {
      user_id: userId || '',
    },
    {
      enabled,
      mutation: NOTIFICATION_MUTATION,
    }
  );
  const notificationRows = result.data;
  const updateRows = result.updateMany;

  // 알림을 읽음/보관 처리하는 모든 경로(자동 읽음, 수동 읽음, 전체 읽음)는
  // 이 updateMany를 거친다. 읽음/보관으로 바뀌는 알림에 대해 같은 단말에 이미
  // 표시된 OS 푸시 알림(배너)도 함께 닫는다.
  const updateMany = useCallback<typeof result.updateMany>(
    (updates) => {
      const guarded = bindNotificationRevisions(updates, notificationRows);
      const mutation = updateRows(
        guarded.map(
          ({ id, changes: { expected_revision: _revision, ...changes } }) => ({
            id,
            changes,
          })
        ),
        {
          notificationRevisions: Object.fromEntries(
            guarded.map(({ id, changes }) => [id, changes.expected_revision])
          ),
        }
      );
      const dismissIds = collectDismissiblePushIds(guarded);
      if (dismissIds.length > 0) {
        void mutation.persisted.then(
          () => dismissDeliveredPushNotifications(dismissIds),
          () => {}
        );
      }
      return mutation;
    },
    [updateRows, notificationRows]
  );

  // Filter before grouping: a mixed group must never reveal a held alert's text.
  const data = useMemo(
    () => result.data.filter(isUserVisibleNotification),
    [result.data]
  );
  const activeNotifications = useMemo(
    () => data.filter((notification) => !notification.dismissed_at),
    [data]
  );

  const archivedNotifications = useMemo(
    () => data.filter((notification) => notification.dismissed_at),
    [data]
  );

  const groupedNotifications = useMemo(
    () => groupNotifications(activeNotifications),
    [activeNotifications]
  );

  const groupedArchivedNotifications = useMemo(
    () => groupNotifications(archivedNotifications),
    [archivedNotifications]
  );

  const unseenCount = useMemo(
    () => groupedNotifications.filter((group) => !group.seen).length,
    [groupedNotifications]
  );

  return {
    ...result,
    data,
    updateMany,
    enabled,
    activeNotifications,
    archivedNotifications,
    groupedNotifications,
    groupedArchivedNotifications,
    unseenCount,
  };
}
