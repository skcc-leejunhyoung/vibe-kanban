import { useEffect, useMemo } from 'react';
import { useNotifications } from '@/shared/hooks/useNotifications';
import { selectUnseenPullRequestCommentNotificationIds } from '@/shared/lib/notifications';

export function useMarkPullRequestNotificationsRead(
  prUrl: string,
  active: boolean
): void {
  const { activeNotifications, updateMany, enabled } = useNotifications();
  const idsToMark = useMemo(
    () =>
      active && enabled
        ? selectUnseenPullRequestCommentNotificationIds(
            activeNotifications,
            prUrl
          )
        : [],
    [active, activeNotifications, enabled, prUrl]
  );
  const idsKey = idsToMark.join(',');

  useEffect(() => {
    if (idsToMark.length === 0) return;

    updateMany(idsToMark.map((id) => ({ id, changes: { seen: true } })));
    // idsKey represents the contents of idsToMark and avoids rerunning the
    // effect only because the notifications shape returned a new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, updateMany]);
}
