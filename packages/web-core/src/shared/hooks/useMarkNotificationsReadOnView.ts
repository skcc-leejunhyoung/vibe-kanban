import { useEffect, useMemo } from 'react';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useNotifications } from '@/shared/hooks/useNotifications';
import { selectUnseenNotificationIdsForView } from '@/shared/lib/notifications';

/**
 * 사용자가 앱 내에서 알림 대상을 직접 "확인"하면 연관된 아직 읽지 않은 알림을
 * 자동으로 읽음 처리한다.
 *
 * 알림 센터에서 항목을 클릭해 진입하는 경우뿐 아니라, 칸반 보드에서 이슈를 바로
 * 열거나 워크스페이스 화면으로 직접 이동하는 경우에도 현재 보고 있는 대상과
 * 연관된 미확인 알림을 읽음 처리한다. 읽음 시맨틱은 알림 센터의 "Mark as read"와
 * 동일하게 `seen: true`만 전송한다(서버가 읽음 처리 시 자동으로 보관함으로 이동).
 *
 * 이 훅은 인증된 모든 페이지에 마운트되는 알림 벨 컨테이너에서 호출되어 라우트
 * 변경마다 동작한다.
 */
export function useMarkNotificationsReadOnView(): void {
  const destination = useCurrentAppDestination();
  const { activeNotifications, updateMany, enabled } = useNotifications();

  const issueId =
    destination && 'issueId' in destination ? destination.issueId : null;
  const workspaceId =
    destination && 'workspaceId' in destination
      ? destination.workspaceId
      : null;

  const idsToMark = useMemo(
    () =>
      enabled
        ? selectUnseenNotificationIdsForView(activeNotifications, {
            issueId,
            workspaceId,
          })
        : [],
    [enabled, activeNotifications, issueId, workspaceId]
  );

  // 배열 참조 변동으로 effect가 불필요하게 재실행되지 않도록 안정적인 키를 사용한다.
  const idsKey = idsToMark.join(',');

  useEffect(() => {
    if (idsToMark.length === 0) {
      return;
    }

    updateMany(idsToMark.map((id) => ({ id, changes: { seen: true } })));
    // idsKey가 idsToMark의 내용을 대표하므로 의존성으로 사용한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, updateMany]);
}
