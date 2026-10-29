import { displayCanonicalNotification } from '@/shared/lib/api';
import { isTauriApp } from '@/shared/lib/platform';

interface NotificationPayload {
  id: string;
  revision: number;
  title: string;
  body: string;
  deeplinkPath?: string;
}

export async function showSystemNotification(
  notification: NotificationPayload
): Promise<void> {
  if (!isTauriApp()) {
    return;
  }

  try {
    await displayCanonicalNotification(notification.id, notification.revision);
  } catch (error) {
    console.error(
      `Failed to show system notification for group ${notification.id}:`,
      error
    );
  }
}
