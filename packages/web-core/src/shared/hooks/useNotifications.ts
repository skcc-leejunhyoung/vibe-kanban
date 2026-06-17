import { useMemo } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  NOTIFICATIONS_SHAPE,
  NOTIFICATION_MUTATION,
} from 'shared/remote-types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { groupNotifications } from '@/shared/lib/notifications';

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
    enabled,
    activeNotifications,
    archivedNotifications,
    groupedNotifications,
    groupedArchivedNotifications,
    unseenCount,
  };
}
