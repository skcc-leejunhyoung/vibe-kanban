import { act, useEffect, type ReactNode } from 'react';
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
import { AppNavigationProvider } from '@/shared/hooks/useAppNavigation';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { UserSystemContext, useUserSystem } from '@/shared/hooks/useUserSystem';
import { useUserSystemController } from '@/shared/hooks/useUserSystemController';
import { configApi } from '@/shared/lib/api';
import { DEFAULT_CONFIG } from '@/shared/lib/defaultConfig';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import type { AppNavigation } from '@/shared/lib/routes/appNavigation';
import { HostIdProvider, useHostId } from '@/shared/providers/HostIdProvider';
import { WorkspacePaneScope } from './WorkspacePaneScope';

const route = vi.hoisted(() => ({ hostId: null as string | null }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ href: '/' }),
}));
vi.mock('@/shared/hooks/useSelfCloudHostId', () => ({
  useSelfCloudHostId: () => ({ hostId: null, isPending: false }),
}));
vi.mock('@/shared/hooks/useMarkNotificationsReadOnView', () => ({
  useMarkNotificationsReadOnView: () => {},
}));
vi.mock('@/shared/hooks/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ selectedSessionId: undefined }),
}));
vi.mock('@/shared/providers/WorkspaceProvider', () => ({
  WorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/shared/providers/ExecutionProcessesProvider', () => ({
  ExecutionProcessesProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock('@/shared/providers/LogsPanelProvider', () => ({
  LogsPanelProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/shared/providers/ActionsProvider', () => ({
  ActionsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/shared/hooks/usePresetOptions', () => ({
  usePresetOptions: () => ({ data: null }),
}));
vi.mock('@/shared/hooks/useExecutorDiscovery', () => ({
  useModelSelectorConfig: () => ({ config: null }),
}));
vi.mock('@/shared/lib/api', () => ({
  configApi: { getConfig: vi.fn(), saveConfig: vi.fn() },
}));

const infoA: UserSystemInfo = {
  version: 'test',
  config: {
    ...DEFAULT_CONFIG,
    executor_profile: { executor: BaseCodingAgent.CODEX, variant: null },
    collapse_completed_turn_steps: false,
  },
  config_revision: 'revision-a',
  profiles_revision: 'profiles-a',
  machine_id: 'machine-a',
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
  executors: { CODEX: {}, CLAUDE_CODE: {} },
};
const infoB: UserSystemInfo = {
  ...infoA,
  machine_id: 'machine-b',
  config_revision: 'revision-b',
  config: {
    ...DEFAULT_CONFIG,
    executor_profile: { executor: BaseCodingAgent.CLAUDE_CODE, variant: null },
    send_message_shortcut: 'Enter',
  },
};
const navigation = {
  resolveFromPath: () => ({
    kind: 'workspace',
    hostId: route.hostId,
    workspaceId: 'document-workspace',
  }),
} as unknown as AppNavigation;
let runtime: AppRuntime;
let auth: AuthContextValue;
let hostA: string | null;
let hostB: string | null;
let client: QueryClient;
let dom: ReturnType<typeof installDomlessReact>;
const systems = new Map<string, ReturnType<typeof useUserSystem>>();
const executors = new Map<string, BaseCodingAgent | null>();
const hosts = new Map<string, string | null>();
const mounts = new Map<string, number>();
const unmounts = new Map<string, number>();

function keyFor(hostId: string | null) {
  return runtime === 'remote'
    ? ['user-system', 'remote-route', hostId ?? 'none']
    : hostId === null
      ? ['user-system', 'local']
      : ['user-system', 'local-route', hostId];
}
function Probe({ id }: { id: string }) {
  const system = useUserSystem();
  const { effectiveExecutor } = useExecutorConfig({
    profiles: system.profiles,
    lastUsedConfig: null,
    configExecutorProfile: system.config?.executor_profile,
    workspaceId: id,
  });
  systems.set(id, system);
  executors.set(id, effectiveExecutor);
  hosts.set(id, useHostId());
  useEffect(() => {
    mounts.set(id, (mounts.get(id) ?? 0) + 1);
    return () => {
      unmounts.set(id, (unmounts.get(id) ?? 0) + 1);
    };
  }, [id]);
  return null;
}
function DocumentSystem({ children }: { children: ReactNode }) {
  const hostId = useHostId();
  const { value } = useUserSystemController({
    queryKey: keyFor(hostId),
    enabled:
      runtime === 'local' ||
      (auth.isLoaded && auth.isSignedIn && hostId !== null),
    load: () => configApi.getConfig(hostId),
    save: (config, revision) => configApi.saveConfig(config, revision, hostId),
  });
  return (
    <UserSystemContext.Provider value={value}>
      {children}
    </UserSystemContext.Provider>
  );
}
function render(focusedHost: string | null) {
  route.hostId = focusedHost;
  return dom.render(
    <QueryClientProvider client={client}>
      <AppRuntimeProvider runtime={runtime}>
        <AuthContext.Provider value={auth}>
          <AppNavigationProvider value={navigation}>
            <HostIdProvider>
              <DocumentSystem>
                <WorkspacePaneScope
                  paneId="pane-a"
                  destination={{
                    kind: 'workspace',
                    workspaceId: 'workspace-a',
                    hostId: hostA,
                  }}
                  onNavigate={() => {}}
                >
                  <Probe id="a" />
                </WorkspacePaneScope>
                <WorkspacePaneScope
                  paneId="pane-b"
                  destination={{
                    kind: 'workspace',
                    workspaceId: 'workspace-b',
                    hostId: hostB,
                  }}
                  onNavigate={() => {}}
                >
                  <Probe id="b" />
                </WorkspacePaneScope>
              </DocumentSystem>
            </HostIdProvider>
          </AppNavigationProvider>
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
beforeEach(() => {
  dom = installDomlessReact();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  auth = { isLoaded: true, isSignedIn: true, userId: 'test-user' };
  hostB = 'host-b';
  for (const map of [systems, executors, hosts, mounts, unmounts]) map.clear();
  vi.mocked(configApi.getConfig)
    .mockReset()
    .mockImplementation(async (hostId) =>
      hostId === 'host-b' ? infoB : infoA
    );
  vi.mocked(configApi.saveConfig).mockReset();
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.unstubAllGlobals();
});

describe.each(['local', 'remote'] as const)(
  '%s pane user system',
  (surface) => {
    beforeEach(() => {
      runtime = surface;
      hostA = surface === 'local' ? null : 'host-a';
      client.setQueryData(keyFor(hostA), infoA);
      client.setQueryData(keyFor(hostB), infoB);
    });

    it('keeps each pane settings and conversation mounted across host focus changes', async () => {
      await render(hostA);
      expect(executors.get('a')).toBe(BaseCodingAgent.CODEX);
      expect(executors.get('b')).toBe(BaseCodingAgent.CLAUDE_CODE);
      const beforeA = systems.get('a');
      const beforeB = systems.get('b');
      for (const focusedHost of [hostB, hostA, hostB, hostA]) {
        await render(focusedHost);
        expect(systems.get('a')).toBe(beforeA);
        expect(systems.get('b')).toBe(beforeB);
        expect(hosts.get('a')).toBe(hostA);
        expect(hosts.get('b')).toBe(hostB);
        expect(executors.get('a')).toBe(BaseCodingAgent.CODEX);
        expect(executors.get('b')).toBe(BaseCodingAgent.CLAUDE_CODE);
        expect(systems.get('a')?.config?.send_message_shortcut).toBe(
          'ModifierEnter'
        );
        expect(systems.get('b')?.config?.send_message_shortcut).toBe('Enter');
        expect(systems.get('a')?.config?.collapse_completed_turn_steps).toBe(
          false
        );
        expect(systems.get('b')?.config?.collapse_completed_turn_steps).toBe(
          true
        );
      }
      expect([...mounts.values()]).toEqual([1, 1]);
      expect(unmounts.size).toBe(0);
      expect(configApi.getConfig).not.toHaveBeenCalled();
    });

    it('saves to the originating pane host even when focus changes before completion', async () => {
      await render(hostB);
      let complete!: (
        value: Awaited<ReturnType<typeof configApi.saveConfig>>
      ) => void;
      vi.mocked(configApi.saveConfig).mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        })
      );
      let save!: Promise<boolean>;
      await act(() => {
        save = systems
          .get('a')!
          .updateAndSaveConfig({ host_nickname: 'Updated A' });
      });
      await render(hostA);
      await render(hostB);
      const savedConfig = { ...infoA.config, host_nickname: 'Updated A' };
      expect(configApi.saveConfig).toHaveBeenCalledExactlyOnceWith(
        savedConfig,
        'revision-a',
        hostA
      );
      await act(async () => {
        complete({ config: savedConfig, revision: 'revision-a-next' });
        await save;
      });
      await flush();
      expect(await save).toBe(true);
      expect(systems.get('a')?.config).toEqual(savedConfig);
      expect(
        client.getQueryData<UserSystemInfo>(keyFor(hostA))?.config_revision
      ).toBe('revision-a-next');
      expect(client.getQueryData(keyFor(hostB))).toEqual(infoB);
      expect(systems.get('b')?.config).toEqual(infoB.config);
    });

    it('isolates an uncached host failure and retries that host without resetting the other pane', async () => {
      client.removeQueries({ queryKey: keyFor(hostB) });
      vi.mocked(configApi.getConfig).mockRejectedValueOnce(
        new Error('synthetic host offline')
      );
      await render(hostA);
      await flush();
      expect(configApi.getConfig).toHaveBeenCalledExactlyOnceWith(hostB);
      expect(systems.get('b')?.configError).toBe(true);
      expect(systems.get('b')?.config).toBeNull();
      const beforeA = systems.get('a');
      vi.mocked(configApi.getConfig).mockResolvedValueOnce(infoB);
      await act(async () => {
        await systems.get('b')!.reloadSystem();
      });
      await flush();
      expect(systems.get('a')).toBe(beforeA);
      expect(systems.get('b')?.configError).toBe(false);
      expect(systems.get('b')?.config).toEqual(infoB.config);
      expect(configApi.getConfig).toHaveBeenCalledTimes(2);
      expect(unmounts.size).toBe(0);
    });

    it('shares one cold request between the shell and panes on the same host', async () => {
      client.clear();
      hostB = hostA;
      await render(hostA);
      await flush();
      expect(configApi.getConfig).toHaveBeenCalledExactlyOnceWith(hostA);
      expect(systems.get('a')?.config).toEqual(infoA.config);
      expect(systems.get('b')?.config).toEqual(infoA.config);
    });
  }
);

it('loads local pane settings without cloud authentication', async () => {
  runtime = 'local';
  hostA = hostB = null;
  auth = { isLoaded: true, isSignedIn: false, userId: null };
  await render(null);
  await flush();
  expect(configApi.getConfig).toHaveBeenCalledExactlyOnceWith(null);
  expect(systems.get('a')?.config).toEqual(infoA.config);
});

it.each([
  { host: null, loaded: true, signedIn: true },
  { host: 'host-a', loaded: false, signedIn: false },
  { host: 'host-a', loaded: true, signedIn: false },
])(
  'does not fetch remote config without a host and loaded authentication: %j',
  async ({ host, loaded, signedIn }) => {
    runtime = 'remote';
    hostA = hostB = host;
    auth = { isLoaded: loaded, isSignedIn: signedIn, userId: null };
    await render(host);
    await flush();
    expect(configApi.getConfig).not.toHaveBeenCalled();
    expect(systems.get('a')?.config).toBeNull();
    expect(systems.get('a')?.loading).toBe(!loaded);
  }
);
