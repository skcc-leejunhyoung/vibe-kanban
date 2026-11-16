import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RelayHost } from 'shared/remote-types';
import { listRelayHosts } from '@/shared/lib/remoteApi';
import { useAppRuntime, type AppRuntime } from '@/shared/hooks/useAppRuntime';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useHostId } from '@/shared/providers/HostIdProvider';
import {
  createMachineClient,
  type MachineClient,
  type MachineTarget,
} from '@/shared/lib/machineClient';
import {
  useRemoteCloudHostsState,
  type RemoteCloudHost,
} from '@/shared/hooks/useRemoteCloudHosts';
import {
  buildRelayHostOptions,
  usePairedRelayHostsQuery,
} from '@/shared/hooks/useWorkspaceHostOptions';
import { RELAY_REMOTE_HOSTS_QUERY_KEY } from '@/shared/lib/relayHostQueryKeys';

export type SettingsHostTargetId = 'local' | string;

/**
 * Sentinel id for the account-scoped "Remote" device: the cloud-stored Config
 * shared across every remote-web session. It has no backing machine, so it is
 * not a {@link MachineTarget} — config load/save go to the remote server.
 */
export const REMOTE_SETTINGS_HOST_ID = 'remote';

export type RemoteSharedSettingsTarget = {
  kind: 'remote-shared';
  id: typeof REMOTE_SETTINGS_HOST_ID;
  apiHostId: null;
  label: string;
  description?: string;
  status?: 'online' | 'offline';
};

export type SettingsHostTarget =
  | (MachineTarget & {
      description?: string;
      status?: 'online' | 'offline';
    })
  | RemoteSharedSettingsTarget;

export function isRemoteSharedHostId(
  id: SettingsHostTargetId | null | undefined
): boolean {
  return id === REMOTE_SETTINGS_HOST_ID;
}

// Stable fallbacks: a fresh `[]` per render would rebuild the host list, the
// selected target and with it the machine client on every render, and the
// sections reload (dropping what is being typed) whenever the client changes.
const NO_RELAY_HOSTS: RelayHost[] = [];
const NO_PAIRED_HOSTS: { host_id: string }[] = [];

interface SettingsHostContextValue {
  availableHosts: SettingsHostTarget[];
  hostsResolved: boolean;
  /**
   * The target is final: the one the dialog was opened for is listed, or the
   * host list has answered without it. Until then the selection is only a
   * placeholder and its settings must not be shown as editable.
   */
  targetResolved: boolean;
  selectedHostId: SettingsHostTargetId | null;
  /**
   * The selected target. A host that drops out of the list keeps its last
   * known entry here, so an open form stays on it instead of being unmounted.
   */
  selectedHost: SettingsHostTarget | null;
  /**
   * The selected host is no longer in the list (removed, access revoked, or
   * a failed listing). It stays selected so the user picks the next target
   * themselves: an open form is never moved to another host behind their back.
   */
  selectedHostUnavailable: boolean;
  setSelectedHostId: (hostId: SettingsHostTargetId) => void;
}

const SettingsHostContext = createContext<SettingsHostContextValue | null>(
  null
);

function toLocalRuntimeTargets(
  remoteHosts: RemoteCloudHost[],
  getLabel: (key: string, defaultValue: string) => string
): SettingsHostTarget[] {
  return [
    {
      id: 'local',
      apiHostId: null,
      label: getLabel('settings.hostPicker.thisMachine', 'This machine'),
      description: getLabel('settings.hostPicker.localHost', 'Local host'),
      kind: 'local',
    },
    ...remoteHosts.map((host) => ({
      id: host.id,
      apiHostId: host.id,
      label: host.name,
      description: getLabel('settings.hostPicker.remoteHost', 'Remote host'),
      status:
        host.status === 'online' ? ('online' as const) : ('offline' as const),
      kind: 'remote' as const,
    })),
  ];
}

function isSameTarget(
  a: SettingsHostTarget,
  b: SettingsHostTarget | null
): boolean {
  return (
    b !== null &&
    a.id === b.id &&
    a.kind === b.kind &&
    a.apiHostId === b.apiHostId &&
    a.label === b.label &&
    a.description === b.description &&
    a.status === b.status
  );
}

function getInitialHostId(
  hosts: SettingsHostTarget[],
  runtime: AppRuntime,
  routeHostId: string | null,
  initialHostId?: SettingsHostTargetId
): SettingsHostTargetId | null {
  if (initialHostId && hosts.some((host) => host.id === initialHostId)) {
    return initialHostId;
  }

  if (routeHostId && hosts.some((host) => host.id === routeHostId)) {
    return routeHostId;
  }

  if (runtime === 'local') {
    return (
      hosts.find((host) => host.id === 'local')?.id ?? hosts[0]?.id ?? null
    );
  }

  // On the remote web, default to the account-scoped "Remote" device so its
  // shared settings are the natural landing target when settings are opened
  // outside a host route.
  return (
    hosts.find((host) => host.id === REMOTE_SETTINGS_HOST_ID)?.id ??
    hosts.find((host) => host.status === 'online')?.id ??
    hosts[0]?.id ??
    null
  );
}

export function SettingsHostProvider({
  initialHostId,
  children,
}: {
  initialHostId?: SettingsHostTargetId;
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const runtime = useAppRuntime();
  const routeHostId = useHostId();
  // The document's host when the dialog opened. The document follows the
  // focused pane (and deep links, back/forward), so reading it live would move
  // an open settings form — and its unsaved draft — to another host.
  const [openedRouteHostId] = useState(routeHostId);
  const { isSignedIn } = useAuth();
  const { data: localRemoteHosts, isError: localRemoteHostsFailed } =
    useRemoteCloudHostsState({
      enabled: runtime === 'local',
    });
  const { data: relayHosts = NO_RELAY_HOSTS, isLoading: relayHostsLoading } =
    useQuery({
      queryKey: RELAY_REMOTE_HOSTS_QUERY_KEY,
      queryFn: listRelayHosts,
      enabled: runtime === 'remote' && isSignedIn,
      staleTime: 30_000,
    });
  const {
    data: pairedRelayHosts = NO_PAIRED_HOSTS,
    isLoading: pairedRelayHostsLoading,
  } = usePairedRelayHostsQuery(runtime === 'remote' && isSignedIn);
  const relayHostsResolved = useMemo(() => {
    if (!isSignedIn) {
      return true;
    }

    return (
      !relayHostsLoading &&
      (!pairedRelayHostsLoading ||
        relayHosts.some((host) => host.auth_mode === 'account'))
    );
  }, [isSignedIn, pairedRelayHostsLoading, relayHostsLoading, relayHosts]);
  // Whether the host list has answered (or failed), i.e. cannot still grow
  // into the target the dialog was opened for.
  const hostListSettled =
    runtime === 'local'
      ? localRemoteHosts !== undefined || localRemoteHostsFailed === true
      : relayHostsResolved;

  const availableHosts = useMemo<SettingsHostTarget[]>(() => {
    if (runtime === 'local') {
      return toLocalRuntimeTargets(localRemoteHosts?.hosts ?? [], t);
    }

    // The account-scoped "Remote" device: shared, cloud-stored settings that
    // every remote-web session reads. Listed first so it is the default target.
    const remoteSharedTarget: SettingsHostTarget = {
      kind: 'remote-shared',
      id: REMOTE_SETTINGS_HOST_ID,
      apiHostId: null,
      label: t('settings.hostPicker.remoteShared', 'Remote'),
      description: t(
        'settings.hostPicker.remoteSharedHint',
        'Shared across your remote web'
      ),
    };

    const machineTargets = buildRelayHostOptions(
      relayHosts,
      pairedRelayHosts
    ).map(
      (host): SettingsHostTarget => ({
        id: host.id,
        apiHostId: host.id,
        label: host.name,
        description: t('settings.hostPicker.remoteHost', 'Remote host'),
        status: host.status === 'online' ? 'online' : 'offline',
        kind: 'remote',
      })
    );
    return [remoteSharedTarget, ...machineTargets];
  }, [localRemoteHosts?.hosts, pairedRelayHosts, relayHosts, runtime, t]);

  const [chosenHostId, setSelectedHostId] =
    useState<SettingsHostTargetId | null>(null);
  const defaultHostId = getInitialHostId(
    availableHosts,
    runtime,
    openedRouteHostId,
    initialHostId
  );
  const preferredHostId =
    initialHostId ??
    openedRouteHostId ??
    (runtime === 'local' ? 'local' : REMOTE_SETTINGS_HOST_ID);
  // The host a caller asked for by name (chat's "customise", a repo action).
  // `'local'` on the remote web is how callers say "no host in particular".
  const requestedHostId =
    initialHostId && !(runtime === 'remote' && initialHostId === 'local')
      ? initialHostId
      : null;
  // The list is final (or failed) without it: keep it selected and say it is
  // unavailable, instead of showing another host's settings in its place.
  const requestedHostMissing =
    requestedHostId !== null &&
    hostListSettled &&
    !availableHosts.some((host) => host.id === requestedHostId);
  const selectedHostId =
    chosenHostId ?? (requestedHostMissing ? requestedHostId : defaultHostId);
  // Local settings never wait for the paired-host list (`hostsResolved`), but
  // a dialog opened for another host does: `targetResolved` is false until
  // that host is listed or the list has answered without it.
  const hostsResolved = runtime === 'local' ? true : hostListSettled;
  const targetResolved =
    chosenHostId !== null ||
    hostListSettled ||
    availableHosts.some((host) => host.id === preferredHostId);

  // The default follows the host list only until it is final. From then on it
  // is pinned like an explicit choice, so a later list refresh cannot retarget
  // the form the user is already looking at.
  useEffect(() => {
    if (chosenHostId !== null || selectedHostId === null) return;
    if (selectedHostId === preferredHostId || hostListSettled) {
      setSelectedHostId(selectedHostId);
    }
  }, [chosenHostId, selectedHostId, hostListSettled, preferredHostId]);

  const listedHost = useMemo(
    () => availableHosts.find((host) => host.id === selectedHostId) ?? null,
    [availableHosts, selectedHostId]
  );
  const [lastListedHost, setLastListedHost] =
    useState<SettingsHostTarget | null>(null);
  // Compared by content: the list is rebuilt on every poll, and following
  // its object identity would re-render for nothing.
  if (listedHost && !isSameTarget(listedHost, lastListedHost)) {
    setLastListedHost(listedHost);
  }
  const selectedHost =
    listedHost ??
    (lastListedHost?.id === selectedHostId ? lastListedHost : null);
  const selectedHostUnavailable =
    hostListSettled && selectedHostId !== null && listedHost === null;

  const value = useMemo<SettingsHostContextValue>(
    () => ({
      availableHosts,
      hostsResolved,
      targetResolved,
      selectedHostId,
      selectedHost,
      selectedHostUnavailable,
      setSelectedHostId,
    }),
    [
      availableHosts,
      hostsResolved,
      targetResolved,
      selectedHost,
      selectedHostId,
      selectedHostUnavailable,
    ]
  );

  return (
    <SettingsHostContext.Provider value={value}>
      {children}
    </SettingsHostContext.Provider>
  );
}

export function useSettingsHost() {
  const context = useContext(SettingsHostContext);
  if (!context) {
    throw new Error(
      'useSettingsHost must be used within a SettingsHostProvider'
    );
  }
  return context;
}

export function useSettingsMachineClient(): MachineClient | null {
  const runtime = useAppRuntime();
  const { selectedHost } = useSettingsHost();

  // Keyed on what identifies the machine, not on the target object: the host
  // list is rebuilt on every poll, and a new client per poll makes sections
  // reload over an unsaved edit.
  const kind = selectedHost?.kind;
  const id = selectedHost?.id;
  const apiHostId = selectedHost?.apiHostId ?? null;
  const label = selectedHost?.label ?? '';
  return useMemo(() => {
    if (!id || kind === undefined || kind === 'remote-shared') {
      return null;
    }

    return createMachineClient(
      runtime,
      kind === 'local'
        ? { kind, id: 'local', apiHostId: null, label }
        : { kind, id, apiHostId: apiHostId ?? id, label }
    );
  }, [runtime, kind, id, apiHostId, label]);
}
