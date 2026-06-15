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
