import { act, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { installFakeDomReact } from './electric/electricTestKit';
import { getRemoteApiUrl, setRemoteApiBase } from './remoteApi';
import { UserSystemProvider } from '../../../../local-web/src/app/providers/ConfigProvider';
import type { UserSystemInfo } from 'shared/types';
import { configApi } from './api';

vi.mock('./api', () => ({ configApi: { getConfig: vi.fn() } }));
vi.mock('@/shared/lib/auth/tokenManager', () => ({
  tokenManager: { syncRecoveryState: vi.fn() },
}));
vi.mock('@/shared/hooks/useConfigPreferenceSync', () => ({
  useConfigPreferenceSync: vi.fn(),
}));
vi.mock('@/i18n/config', () => ({ updateLanguageFromConfig: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let dom: ReturnType<typeof installFakeDomReact>;
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  setRemoteApiBase(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('waits for the configured origin before mounting consumers and keeps them on refetch', async () => {
  dom = installFakeDomReact();
  let resolve!: (info: UserSystemInfo) => void;
  vi.mocked(configApi.getConfig).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const origins: string[] = [];
  const unmount = vi.fn();
  function Consumer() {
    useEffect(() => {
      origins.push(getRemoteApiUrl());
      return unmount;
    }, []);
    return null;
  }
  await dom.render(
    <QueryClientProvider client={client}>
      <UserSystemProvider>
        <Consumer />
      </UserSystemProvider>
    </QueryClientProvider>
  );
  expect(origins).toEqual([]);
  await act(async () =>
    resolve({
      shared_api_base: 'https://central.test',
      login_status: { status: 'loggedout' },
    } as UserSystemInfo)
  );
  await vi.waitFor(() => expect(origins).toEqual(['https://central.test']));
  await act(async () => {
    void client.invalidateQueries({ queryKey: ['user-system', 'local'] });
  });
  expect(unmount).not.toHaveBeenCalled();
  expect(origins).toHaveLength(1);
});

it('does not mount consumers on initial failure and recovers on retry', async () => {
  dom = installFakeDomReact();
  vi.mocked(configApi.getConfig)
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue({
      shared_api_base: 'https://central.test',
    } as UserSystemInfo);
  const mounted = vi.fn();
  function Consumer() {
    mounted();
    return null;
  }
  await dom.render(
    <QueryClientProvider client={client}>
      <UserSystemProvider>
        <Consumer />
      </UserSystemProvider>
    </QueryClientProvider>
  );
  await vi.waitFor(() =>
    expect(client.getQueryState(['user-system', 'local'])?.status).toBe('error')
  );
  expect(mounted).not.toHaveBeenCalled();
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['user-system', 'local'] });
  });
  await vi.waitFor(() => expect(mounted).toHaveBeenCalled());
});
