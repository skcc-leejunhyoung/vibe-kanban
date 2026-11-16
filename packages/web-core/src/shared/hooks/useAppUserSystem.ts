import type { SendMessageShortcut } from 'shared/types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { useHostUserSystem } from '@/shared/hooks/useHostUserSystem';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';
import {
  useUserSystem,
  type UserSystemContextType,
} from '@/shared/hooks/useUserSystem';
import {
  REMOTE_SHARED_USER_SYSTEM_QUERY_KEY,
  loadRemoteSharedUserSystemInfo,
  saveRemoteSharedConfig,
} from '@/shared/lib/remoteSharedConfig';

/**
 * The settings owner of the app itself: this machine on the local web, the
 * account's shared "Remote" config on the remote web. App-wide state (release
 * notes, guides already shown, how a quick chat opens, this machine's relay)
 * belongs here. `useUserSystem()` answers for a host instead, and that host
 * changes with the route, the focused pane, or a dialog's own host picker.
 */
export function useAppUserSystem(): UserSystemContextType {
  const runtime = useAppRuntime();
  const { isLoaded, isSignedIn } = useAuth();
  const local = useHostUserSystem(null, { enabled: runtime === 'local' });
  const shared = useUserSystemController({
    queryKey: REMOTE_SHARED_USER_SYSTEM_QUERY_KEY,
    enabled: runtime === 'remote' && isLoaded && isSignedIn,
    load: loadRemoteSharedUserSystemInfo,
    save: saveRemoteSharedConfig,
  });
  return runtime === 'local' ? local.value : shared.value;
}

/**
 * How Enter behaves in this app's message inputs. It is a habit of the person
 * typing, so it comes from the app's own settings and not from the host a
 * pane, a draft or a dialog happens to be on.
 */
export function useSendMessageShortcut(): SendMessageShortcut | undefined {
  return useAppUserSystem().config?.send_message_shortcut;
}

/**
 * State of the machine the app itself runs on: its login, machine id and
 * version. On the local web that is this machine, whichever host the route or
 * the focused pane is on. The remote web has no machine of its own, so there
 * this stays the route host's. Preferences are not machine state: they come
 * from `useAppUserSystem()`.
 */
export function useAppMachineSystem(): UserSystemContextType {
  const runtime = useAppRuntime();
  const ambient = useUserSystem();
  const local = useHostUserSystem(null, { enabled: runtime === 'local' });
  return runtime === 'local' ? local.value : ambient;
}
