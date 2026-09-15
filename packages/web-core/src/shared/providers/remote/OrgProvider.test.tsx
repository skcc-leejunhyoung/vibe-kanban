import { act, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureTestAuthRuntime,
  emitSnapshotsByTable,
  installDomlessReact,
  resetElectricSessions,
} from '@/shared/lib/electric/electricTestKit';
import {
  useOrgContext,
  type OrgContextValue,
} from '@/shared/hooks/useOrgContext';
import { OrgProvider } from './OrgProvider';

vi.mock('@tanstack/electric-db-collection', async () => {
  const kit = await import('@/shared/lib/electric/electricTestKit');
  return { electricCollectionOptions: kit.fakeElectricCollectionOptions };
});
vi.mock('@/shared/lib/remoteApi', () => ({
  makeRequest: vi.fn(),
  getRemoteApiUrl: () => 'http://api.test',
}));
vi.mock('@/shared/lib/api', () => ({
  organizationsApi: {
    getMembers: vi.fn(async () => [
      { user_id: 'u1', first_name: 'Ada', last_name: 'L' },
    ]),
  },
}));

let dom: ReturnType<typeof installDomlessReact>;
let orgCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  resetElectricSessions();
  configureTestAuthRuntime();
  dom = installDomlessReact();
});

afterEach(async () => {
  await dom.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderProvider() {
  const organizationId = `org${++orgCounter}`;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const values: OrgContextValue[] = [];
  let bump: () => void = () => {};
  function Probe() {
    values.push(useOrgContext());
    return null;
  }
  function Host() {
    const [, setTick] = useState(0);
    bump = () => setTick((tick) => tick + 1);
    return (
      <QueryClientProvider client={client}>
        <OrgProvider organizationId={organizationId}>
          <Probe />
        </OrgProvider>
      </QueryClientProvider>
    );
  }
  await dom.render(<Host />);
  await act(() =>
    emitSnapshotsByTable({
      projects: [{ id: 'pr1', organization_id: organizationId, name: 'P' }],
    })
  );
  // Let the members query settle.
  await act(() => vi.advanceTimersByTimeAsync(10));

  return {
    latest: () => values[values.length - 1],
    rerenderParent: () => act(() => bump()),
  };
}

describe('OrgProvider context stability', () => {
  it('keeps the context value when the parent re-renders without changes', async () => {
    const provider = await renderProvider();
    const settled = provider.latest();
    expect(settled.isLoading).toBe(false);
    expect(settled.projects.map((p) => p.id)).toEqual(['pr1']);
    expect(settled.membersWithProfilesById.has('u1')).toBe(true);

    await provider.rerenderParent();
    await provider.rerenderParent();

    expect(provider.latest()).toBe(settled);
  });
});
