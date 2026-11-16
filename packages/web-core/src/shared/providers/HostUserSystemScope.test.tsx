import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent, type UserSystemInfo } from 'shared/types';
import {
  AuthContext,
  type AuthContextValue,
} from '@/shared/hooks/auth/useAuth';
import {
  AppRuntimeProvider,
  type AppRuntime,
} from '@/shared/hooks/useAppRuntime';
import {
  useAppMachineSystem,
  useAppUserSystem,
  useSendMessageShortcut,
} from '@/shared/hooks/useAppUserSystem';
import { useHostUserSystem } from '@/shared/hooks/useHostUserSystem';
import { UserSystemContext, useUserSystem } from '@/shared/hooks/useUserSystem';
import { configApi } from '@/shared/lib/api';
import { DEFAULT_CONFIG } from '@/shared/lib/defaultConfig';
import {
  loadRemoteSharedUserSystemInfo,
  saveRemoteSharedConfig,
} from '@/shared/lib/remoteSharedConfig';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import {
  getHostRequestScopeQueryKey,
  getHostUserSystemQueryKey,
} from '@/shared/lib/hostRequestScope';
import { HostIdContext, useHostId } from '@/shared/providers/HostIdProvider';
import { SettingsMachineUserSystemProvider } from '@/shared/dialogs/settings/settings/SettingsMachineUserSystemProvider';
import { HostUserSystemScope } from './HostUserSystemScope';

const settings = vi.hoisted(() => ({ hostId: null as string | null }));
vi.mock('@/shared/lib/api', () => ({
  configApi: { getConfig: vi.fn(), saveConfig: vi.fn() },
}));
// The account's shared "Remote" config, the app's own settings on the remote web.
vi.mock('@/shared/lib/remoteSharedConfig', () => ({
  REMOTE_SHARED_USER_SYSTEM_QUERY_KEY: ['user-system', 'remote-shared'],
  loadRemoteSharedUserSystemInfo: vi.fn(),
  saveRemoteSharedConfig: vi.fn(),
}));
vi.mock('@/shared/dialogs/settings/settings/SettingsHostContext', () => ({
  useSettingsMachineClient: () => ({
    target: { apiHostId: settings.hostId },
  }),
}));

function info(
  machine: string,
  executor: BaseCodingAgent,
  nickname: string
): UserSystemInfo {
  return {
    version: 'test',
    config: {
      ...DEFAULT_CONFIG,
      host_nickname: nickname,
      executor_profile: { executor, variant: null },
    },
    config_revision: `config-${machine}`,
    profiles_revision: `profiles-${machine}`,
    machine_id: machine,
    login_status: { status: 'loggedout' },
    remote_auth_degraded: null,
    environment: {
      os_type: 'test',
      os_version: 'test',
      os_architecture: 'test',
      bitness: '64',
    },
    capabilities: {},
    shared_api_base: null,
    preview_proxy_port: null,
    executors: { [executor]: {} },
  } as UserSystemInfo;
}
const infoA = info('machine-a', BaseCodingAgent.CODEX, 'Studio');
const infoB = info('machine-b', BaseCodingAgent.CLAUDE_CODE, 'Laptop');

const auth: AuthContextValue = {
  isLoaded: true,
  isSignedIn: true,
  userId: 'synthetic-user',
};
let runtime: AppRuntime;
let client: QueryClient;
let dom: ReturnType<typeof installDomlessReact>;
const seen = new Map<
  string,
  { system: ReturnType<typeof useUserSystem>; hostId: string | null }
>();

function Probe({ id }: { id: string }) {
  seen.set(id, { system: useUserSystem(), hostId: useHostId() });
  return null;
}
function MachineProbe() {
  seen.set('machine', { system: useAppMachineSystem(), hostId: null });
  return null;
}
/** Stands in for the document providers: host + its user system. */
function Document({
  hostId,
  children,
}: {
  hostId: string | null;
  children: ReactNode;
}) {
  const { value } = useHostUserSystem(hostId);
  return (
    <HostIdContext.Provider value={hostId}>
      <UserSystemContext.Provider value={value}>
        {children}
      </UserSystemContext.Provider>
    </HostIdContext.Provider>
  );
}
function render(documentHostId: string | null, children: ReactNode) {
  return dom.render(
    <QueryClientProvider client={client}>
      <AppRuntimeProvider runtime={runtime}>
        <AuthContext.Provider value={auth}>
          <Document hostId={documentHostId}>{children}</Document>
        </AuthContext.Provider>
      </AppRuntimeProvider>
    </QueryClientProvider>
  );
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
const cached = (hostId: string | null) =>
  client.getQueryData<UserSystemInfo>(
    getHostUserSystemQueryKey(runtime, hostId)
  );

beforeEach(() => {
  dom = installDomlessReact();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = 'local';
  settings.hostId = 'host-b';
  seen.clear();
  vi.mocked(configApi.getConfig)
    .mockReset()
    .mockImplementation(async (hostId) =>
      hostId === 'host-b' ? infoB : infoA
    );
  vi.mocked(configApi.saveConfig)
    .mockReset()
    .mockImplementation(async (config, revision) => ({
      config,
      revision: `${revision}-next`,
    }));
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
});

describe('host user system scope', () => {
  it('answers for its own host under a document that is on another one', async () => {
    for (const documentHost of [null, 'host-b', null]) {
      await render(
        documentHost,
        <>
          <Probe id="document" />
          <HostUserSystemScope hostId="host-b">
            <Probe id="picked-b" />
          </HostUserSystemScope>
          <HostUserSystemScope hostId={null}>
            <Probe id="picked-this-machine" />
          </HostUserSystemScope>
        </>
      );
      await flush();
      expect(seen.get('picked-b')?.hostId).toBe('host-b');
      expect(seen.get('picked-b')?.system.machineId).toBe('machine-b');
      expect(seen.get('picked-b')?.system.config?.executor_profile).toEqual({
        executor: BaseCodingAgent.CLAUDE_CODE,
        variant: null,
      });
      expect(seen.get('picked-this-machine')?.hostId).toBeNull();
      expect(seen.get('picked-this-machine')?.system.machineId).toBe(
        'machine-a'
      );
      expect(seen.get('document')?.system.machineId).toBe(
        documentHost === null ? 'machine-a' : 'machine-b'
      );
    }
  });

  it('sends nothing to a host it is told not to reach', async () => {
    await render(
      null,
      <HostUserSystemScope hostId="host-b" enabled={false}>
        <Probe id="picked-b" />
      </HostUserSystemScope>
    );
    await flush();
    expect(configApi.getConfig).not.toHaveBeenCalledWith('host-b');
    expect(seen.get('picked-b')?.system.config).toBeNull();
  });

  it('saves to its own host with that host’s config and revision', async () => {
    await render(
      null,
      <HostUserSystemScope hostId="host-b">
        <Probe id="picked-b" />
      </HostUserSystemScope>
    );
    await flush();
    await act(async () => {
      await seen
        .get('picked-b')!
        .system.updateAndSaveConfig({ host_nickname: 'Renamed' });
    });
    expect(configApi.saveConfig).toHaveBeenCalledExactlyOnceWith(
      { ...infoB.config, host_nickname: 'Renamed' },
      'config-machine-b',
      'host-b'
    );
    expect(cached('host-b')?.config.host_nickname).toBe('Renamed');
    expect(cached(null)).toEqual(infoA);
  });

  it('updates the sidebar colour of the host that was saved, and only that one', async () => {
    const colourKey = (hostId: string | null) => [
      'user-system',
      'workspace-host-primary-color',
      getHostRequestScopeQueryKey(hostId),
    ];
    client.setQueryData(colourKey('host-b'), { primary_color: 'blue' });
    client.setQueryData(colourKey(null), { primary_color: 'blue' });
    await render(
      null,
      <HostUserSystemScope hostId="host-b">
        <Probe id="picked-b" />
      </HostUserSystemScope>
    );
    await flush();
    await act(async () => {
      await seen
        .get('picked-b')!
        .system.updateAndSaveConfig({ primary_color: 'green' });
    });
    expect(client.getQueryData(colourKey('host-b'))).toEqual({
      primary_color: 'green',
    });
    expect(client.getQueryData(colourKey(null))).toEqual({
      primary_color: 'blue',
    });
  });

  it('reads this machine for app state whichever host the document is on', async () => {
    for (const documentHost of ['host-b', null, 'host-b']) {
      await render(documentHost, <MachineProbe />);
      await flush();
      expect(seen.get('machine')?.system.machineId).toBe('machine-a');
    }
  });
});

describe('the app’s own preferences', () => {
  // Host B sends on Enter; this machine and the account keep their own value.
  const withSendKey = (info: UserSystemInfo, key: 'Enter' | 'ModifierEnter') =>
    ({
      ...info,
      config: { ...info.config, send_message_shortcut: key },
    }) as UserSystemInfo;
  let sendKey: string | undefined;
  let app: ReturnType<typeof useAppUserSystem>;
  function AppProbe() {
    sendKey = useSendMessageShortcut();
    app = useAppUserSystem();
    return null;
  }

  beforeEach(() => {
    vi.mocked(configApi.getConfig).mockImplementation(async (hostId) =>
      hostId === 'host-b' ? withSendKey(infoB, 'Enter') : infoA
    );
    vi.mocked(loadRemoteSharedUserSystemInfo)
      .mockReset()
      .mockResolvedValue({
        ...withSendKey(infoA, 'Enter'),
        machine_id: '',
        config_revision: 'shared-1',
      });
    vi.mocked(saveRemoteSharedConfig)
      .mockReset()
      .mockImplementation(async (config) => ({
        config,
        revision: 'shared-2',
      }));
  });

  it('come from this machine on the local web, not from the host a pane is on', async () => {
    await render('host-b', <AppProbe />);
    await flush();
    expect(sendKey).toBe('ModifierEnter');
  });

  it('come from the account’s shared config on the remote web', async () => {
    runtime = 'remote';
    // The document's host keeps the default; the account chose Enter.
    vi.mocked(configApi.getConfig).mockResolvedValue(infoB);
    await render('host-b', <AppProbe />);
    await flush();
    expect(sendKey).toBe('Enter');
  });

  it('are saved to the shared config on the remote web, never to the host', async () => {
    runtime = 'remote';
    await render('host-b', <AppProbe />);
    await flush();
    // What dismissing a guide writes.
    await act(async () => {
      await app.updateAndSaveConfig({
        showcases: { seen_features: ['workspaces-guide'] },
      });
    });
    expect(saveRemoteSharedConfig).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(saveRemoteSharedConfig).mock.calls[0][0].showcases
    ).toEqual({ seen_features: ['workspaces-guide'] });
    expect(configApi.saveConfig).not.toHaveBeenCalled();
  });
});

describe.each(['local', 'remote'] as const)(
  'one config cache per host on the %s web',
  (surface) => {
    beforeEach(() => {
      runtime = surface;
    });

    it('shows a settings save in the pane of the same host at once', async () => {
      await render(
        surface === 'local' ? null : 'host-a',
        <>
          <HostUserSystemScope hostId="host-b">
            <Probe id="pane-b" />
          </HostUserSystemScope>
          <SettingsMachineUserSystemProvider>
            <Probe id="settings-b" />
          </SettingsMachineUserSystemProvider>
        </>
      );
      await flush();
      // One request for the host, shared by both surfaces.
      expect(
        vi
          .mocked(configApi.getConfig)
          .mock.calls.filter(([hostId]) => hostId === 'host-b')
      ).toHaveLength(1);
      expect(seen.get('settings-b')?.hostId).toBe('host-b');

      await act(async () => {
        await seen
          .get('settings-b')!
          .system.updateAndSaveConfig({ host_nickname: 'Saved in settings' });
      });
      // No refetch, no remount: the pane reads the entry the save wrote.
      await flush();
      expect(seen.get('pane-b')?.system.config?.host_nickname).toBe(
        'Saved in settings'
      );
      expect(
        vi
          .mocked(configApi.getConfig)
          .mock.calls.filter(([hostId]) => hostId === 'host-b')
      ).toHaveLength(1);

      // And the other way round, with the revision the first save returned.
      await act(async () => {
        await seen
          .get('pane-b')!
          .system.updateAndSaveConfig({ host_nickname: 'Saved in pane' });
      });
      await flush();
      expect(configApi.saveConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({ host_nickname: 'Saved in pane' }),
        'config-machine-b-next',
        'host-b'
      );
      expect(seen.get('settings-b')?.system.config?.host_nickname).toBe(
        'Saved in pane'
      );
    });

    it('keeps a late response for one host out of the other host’s cache', async () => {
      let finish!: () => void;
      vi.mocked(configApi.saveConfig).mockImplementationOnce(
        (config, revision) =>
          new Promise((resolve) => {
            finish = () => resolve({ config, revision: `${revision}-next` });
          })
      );
      const hostA = surface === 'local' ? null : 'host-a';
      await render(
        hostA,
        <>
          <HostUserSystemScope hostId="host-b">
            <Probe id="b" />
          </HostUserSystemScope>
          <HostUserSystemScope hostId={hostA}>
            <Probe id="a" />
          </HostUserSystemScope>
        </>
      );
      await flush();
      let saving!: Promise<boolean>;
      await act(() => {
        saving = seen
          .get('b')!
          .system.updateAndSaveConfig({ host_nickname: 'Slow save on B' });
      });
      // Meanwhile A is saved and answered first.
      await act(async () => {
        await seen
          .get('a')!
          .system.updateAndSaveConfig({ host_nickname: 'Fast save on A' });
      });
      await act(async () => {
        finish();
        expect(await saving).toBe(true);
      });
      expect(cached(hostA)?.config.host_nickname).toBe('Fast save on A');
      expect(cached(hostA)?.config_revision).toBe('config-machine-a-next');
      expect(cached('host-b')?.config.host_nickname).toBe('Slow save on B');
      expect(cached('host-b')?.config_revision).toBe('config-machine-b-next');
    });

    it('takes an unsaved value back out when the host rejects it and cannot be re-read', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await render(
        surface === 'local' ? null : 'host-a',
        <>
          <HostUserSystemScope hostId="host-b">
            <Probe id="pane-b" />
          </HostUserSystemScope>
          <SettingsMachineUserSystemProvider>
            <Probe id="settings-b" />
          </SettingsMachineUserSystemProvider>
        </>
      );
      await flush();
      vi.mocked(configApi.saveConfig).mockRejectedValueOnce(
        new Error('synthetic revision conflict')
      );
      vi.mocked(configApi.getConfig).mockRejectedValue(
        new Error('synthetic host offline')
      );
      let saved!: boolean;
      await act(async () => {
        saved = await seen
          .get('settings-b')!
          .system.updateAndSaveConfig({ host_nickname: 'Never saved' });
      });
      await flush();
      expect(saved).toBe(false);
      for (const id of ['pane-b', 'settings-b']) {
        expect(seen.get(id)?.system.config?.host_nickname).toBe('Laptop');
      }
    });
  }
);
