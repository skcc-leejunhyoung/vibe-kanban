import { useEffect } from 'react';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { reconcileWebPushRegistration } from '@/shared/lib/webPush';

/**
 * On every app load, migrate a paired local host's web-push subscription from
 * the local server to the remote.
 *
 * `reconcileWebPushRegistration` is a no-op for the remote runtime, for unpaired
 * local hosts, and for devices that have not granted push permission — so this
 * is safe to run unconditionally on boot.
 *
 * Why it matters: a desktop that subscribed before the remote-routing logic (or
 * while briefly unpaired) keeps a subscription only on its local server. The
 * cloud pushes remote-originated notifications — including **remote workspace
 * completion** — solely to the remote's own subscriptions, so a local-only
 * subscription never receives them. Previously this migration ran only when the
 * user happened to open the Notifications settings page; running it on boot
 * guarantees every paired device becomes reachable by the cloud.
 */
export function useWebPushReconcile(): void {
  const runtime = useAppRuntime();

  useEffect(() => {
    void reconcileWebPushRegistration(runtime).catch(() => {});
  }, [runtime]);
}
