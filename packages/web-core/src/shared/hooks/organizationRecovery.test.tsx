import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { organizationsApi } from '@/shared/lib/api';
import { useOrganizationMembers } from './useOrganizationMembers';
import { useUserOrganizations } from './useUserOrganizations';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';

// Let Query's interval scheduler run as it does in the browser.
vi.hoisted(() => {
  Object.assign(globalThis, { window: new EventTarget() });
});

vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ isSignedIn: true }),
}));
vi.mock('@/shared/lib/api', () => ({
  organizationsApi: { getMembers: vi.fn(), getUserOrganizations: vi.fn() },
}));

let dom: ReturnType<typeof installDomlessReact>;
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  dom = installDomlessReact();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(organizationsApi.getMembers).mockReset().mockResolvedValue([]);
  vi.mocked(organizationsApi.getUserOrganizations)
    .mockReset()
    .mockResolvedValue({ organizations: [] });
});
afterEach(async () => {
  await dom.unmount();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['members', 'organizations'] as const)(
  'cancels a stalled initial %s request and ignores its late response',
  async (kind) => {
    let resolveOld!: (value: never) => void;
    let oldSignal!: AbortSignal;
    const pending = new Promise<never>((resolve) => {
      resolveOld = resolve;
    });
    if (kind === 'members') {
      vi.mocked(organizationsApi.getMembers).mockImplementationOnce(
        (_id, signal) => {
          oldSignal = signal!;
          return pending;
        }
      );
    } else {
      vi.mocked(organizationsApi.getUserOrganizations).mockImplementationOnce(
        (signal) => {
          oldSignal = signal!;
          return pending;
        }
      );
    }
    let members!: ReturnType<typeof useOrganizationMembers>;
    let organizations!: ReturnType<typeof useUserOrganizations>;
    function Probe() {
      members = useOrganizationMembers('org');
      organizations = useUserOrganizations();
      return null;
    }
    await dom.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    );
    await act(() => vi.advanceTimersByTimeAsync(1));
    const latest = () => (kind === 'members' ? members : organizations);
    expect(latest().isLoading).toBe(true);
    await act(async () => {
      await latest().retry();
    });
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(oldSignal.aborted).toBe(true);
    expect(latest().isLoading).toBe(false);
    expect(latest().isError).toBe(false);
    const expected = kind === 'members' ? [] : { organizations: [] };
    expect(latest().data).toEqual(expected);
    expect(
      kind === 'members'
        ? organizationsApi.getMembers
        : organizationsApi.getUserOrganizations
    ).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveOld({ stale: true } as never);
    });
    expect(latest().data).toEqual(expected);
  }
);

it.each(['members', 'organizations'] as const)(
  'automatically recovers a failed %s lookup and stops polling after success',
  async (kind) => {
    const request =
      kind === 'members'
        ? organizationsApi.getMembers
        : organizationsApi.getUserOrganizations;
    vi.mocked(request).mockRejectedValueOnce(new Error('Offline'));
    let members!: ReturnType<typeof useOrganizationMembers>;
    let organizations!: ReturnType<typeof useUserOrganizations>;
    function Probe() {
      members = useOrganizationMembers('org');
      organizations = useUserOrganizations();
      return null;
    }
    await dom.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    );
    await act(() => vi.advanceTimersByTimeAsync(1));
    const latest = () => (kind === 'members' ? members : organizations);
    expect(latest().isError).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(30_001));
    expect(latest().isError).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(60_001));
    expect(request).toHaveBeenCalledTimes(2);
  }
);
