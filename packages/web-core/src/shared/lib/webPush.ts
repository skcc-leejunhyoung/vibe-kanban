import type { AppRuntime } from '@/shared/hooks/useAppRuntime';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { makeRequest as makeRemoteRequest } from '@/shared/lib/remoteApi';

type PublicKeyResponse = {
  enabled: boolean;
  public_key?: string | null;
};

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  message?: string;
};

export type WebPushStatus =
  | 'unsupported'
  | 'disabled'
  | 'default'
  | 'denied'
  | 'subscribed'
  | 'unsubscribed';

export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getWebPushStatus(
  runtime: AppRuntime
): Promise<WebPushStatus> {
  if (!isWebPushSupported()) return 'unsupported';

  const publicKey = await getPublicKey(runtime);
  if (!publicKey) return 'disabled';

  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'default';

  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'subscribed' : 'unsubscribed';
}

export async function enableWebPush(runtime: AppRuntime): Promise<void> {
  if (!isWebPushSupported()) {
    throw new Error('Web Push is not supported');
  }

  const publicKey = await getPublicKey(runtime);
  if (!publicKey) {
    throw new Error('Web Push is not enabled on this server');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted');
  }

  const registration = await navigator.serviceWorker.register('/sw.js');
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await saveSubscription(runtime, subscription);
}

export async function disableWebPush(runtime: AppRuntime): Promise<void> {
  if (!isWebPushSupported()) return;

  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  await deleteSubscription(runtime, subscription);
  await subscription.unsubscribe();
}

/**
 * 읽음/보관으로 전환되는 알림 업데이트 중, 같은 단말의 OS 푸시 배너를 닫아야
 * 하는 알림 id를 고른다.
 *
 * `seen === true`는 자동·수동·전체 읽음 모든 경로가 보내는 값이다. `archived`는
 * 현재 클라이언트가 직접 보내지 않고(서버가 읽음 처리 시 `dismissed_at`으로 자동
 * 보관 이동) 향후 명시적 보관 mutation을 대비한 분기다 — 도달하더라도 동일하게
 * 배너를 닫으면 되므로 함께 처리한다.
 */
export function collectDismissiblePushIds(
  updates: ReadonlyArray<{
    id: string;
    changes: { seen?: boolean | null; archived?: boolean | null };
  }>
): string[] {
  return updates
    .filter(({ changes }) => changes.seen === true || changes.archived === true)
    .map(({ id }) => id);
}

/**
 * 이미 단말에 표시된(잠금화면/알림센터) 웹 푸시 알림 중, 전달된 알림 id와
 * 일치하는 것을 닫는다.
 *
 * 서비스 워커는 푸시를 표시할 때 notification `tag`를 알림 id로 설정하므로
 * (packages/public/sw.js: `tag: payload.notification_id`), "알림 id == 표시된
 * 알림의 tag"가 성립한다. 사용자가 앱에서 해당 워크스페이스/이슈를 직접 확인해
 * 알림이 읽음 처리될 때 이 함수를 호출하면, 같은 단말에 떠 있던 푸시 배너도
 * 함께 사라진다.
 *
 * 한계: 같은 단말의 알림만 정리할 수 있다. 다른 단말(예: 폰에 떠 있는 알림을
 * 노트북에서 확인)의 알림은 정리하지 못한다 — iOS는 모든 푸시가 알림을
 * 표시하도록 강제하므로 무음 "정리용 푸시"를 보낼 수 없다.
 */
export async function dismissDeliveredPushNotifications(
  notificationIds: string[]
): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  const tags = notificationIds.filter((id) => id.length > 0);
  if (tags.length === 0) {
    return;
  }

  try {
    const registration =
      await navigator.serviceWorker.getRegistration('/sw.js');
    if (!registration) {
      return;
    }

    // iOS standalone PWA에서 가장 신뢰성 있는 경로: 서비스 워커가 직접 닫는다.
    registration.active?.postMessage({ type: 'vk-dismiss', tags });

    // 데스크톱 등 페이지 컨텍스트가 신뢰 가능한 환경을 위한 보강(중복 닫기는
    // 무해하다).
    const tagSet = new Set(tags);
    const notifications = await registration.getNotifications();
    for (const notification of notifications) {
      if (tagSet.has(notification.tag)) {
        notification.close();
      }
    }
  } catch {
    // 알림 닫기는 부가 기능이므로 실패는 조용히 무시한다.
  }
}

async function getPublicKey(runtime: AppRuntime): Promise<string | null> {
  const response = await request(runtime, '/web-push/public-key', {
    method: 'GET',
  });
  if (!response.ok) return null;

  const payload = await response.json();
  const data = unwrapResponse<PublicKeyResponse>(payload);
  return data.enabled ? (data.public_key ?? null) : null;
}

async function saveSubscription(
  runtime: AppRuntime,
  subscription: PushSubscription
) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Invalid push subscription');
  }

  const response = await request(runtime, '/web-push/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: {
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to save push subscription');
  }
}

async function deleteSubscription(
  runtime: AppRuntime,
  subscription: PushSubscription
) {
  const json = subscription.toJSON();
  if (!json.endpoint) return;

  await request(runtime, '/web-push/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint: json.endpoint }),
  });
}

async function request(
  runtime: AppRuntime,
  path: string,
  options: RequestInit
): Promise<Response> {
  if (runtime === 'remote') {
    return makeRemoteRequest(`/v1${path}`, options);
  }

  const headers = new Headers(options.headers ?? {});
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return makeLocalApiRequest(`/api${path}`, {
    ...options,
    headers,
    hostScope: 'none',
  });
}

function unwrapResponse<T>(payload: T | ApiResponse<T>): T {
  if (
    payload &&
    typeof payload === 'object' &&
    'success' in payload &&
    'data' in payload
  ) {
    return (payload as ApiResponse<T>).data as T;
  }

  return payload as T;
}

function urlBase64ToUint8Array(value: string): BufferSource {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));

  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }

  return output;
}
