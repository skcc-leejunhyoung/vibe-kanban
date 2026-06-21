import { useCallback, useMemo } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  NOTIFICATIONS_SHAPE,
  NOTIFICATION_MUTATION,
} from 'shared/remote-types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { groupNotifications } from '@/shared/lib/notifications';
import { dismissDeliveredPushNotifications } from '@/shared/lib/webPush';

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

  // 알림을 읽음/보관 처리하는 모든 경로(자동 읽음, 수동 읽음, 전체 읽음)는
  // 이 updateMany를 거친다. 읽음/보관으로 바뀌는 알림에 대해 같은 단말에 이미
  // 표시된 OS 푸시 알림(배너)도 함께 닫는다.
  const updateMany = useCallback<typeof result.updateMany>(
    (updates) => {
      const dismissIds = updates
        .filter(
          ({ changes }) => changes.seen === true || changes.archived === true
        )
        .map(({ id }) => id);
      if (dismissIds.length > 0) {
        void dismissDeliveredPushNotifications(dismissIds);
      }
      return result.updateMany(updates);
    },
    [result.updateMany]
  );

  const activeNotifications = useMemo(
    () => result.data.filter((notification) => !notification.dismissed_at),
    [result.data]
  );

  const archivedNotifications = useMemo(
    () => result.data.filter((notification) => notification.dismissed_at),
    [result.data]
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
    updateMany,
    enabled,
    activeNotifications,
    archivedNotifications,
    groupedNotifications,
    groupedArchivedNotifications,
    unseenCount,
  };
}
