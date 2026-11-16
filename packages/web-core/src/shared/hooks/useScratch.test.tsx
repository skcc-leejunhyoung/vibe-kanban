import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScratchType, type UpdateScratch } from 'shared/types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { scratchApi } from '@/shared/lib/api';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { HostIdContext } from '@/shared/providers/HostIdProvider';
import { useScratch, type UseScratchResult } from './useScratch';

// The focused pane's host: what a request without an explicit host follows.
const focused = vi.hoisted(() => ({ hostId: 'host-focused' as string | null }));
vi.mock('@/shared/providers/HostIdProvider', async () => {
  const { createContext, useContext } = await import('react');
  const HostIdContext = createContext<string | null>(null);
  return {
    HostIdContext,
    useHostId: () => useContext(HostIdContext),
    getCurrentHostId: () => focused.hostId,
  };
});
vi.mock('@/shared/hooks/useAppRuntime', () => ({
  useAppRuntime: () => 'local',
}));
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: 'synthetic' }),
}));
vi.mock('@/shared/hooks/useLocalStorageScratch', () => ({
  useLocalStorageScratch: () => ({}),
}));
vi.mock('@/shared/hooks/useJsonPatchWsStream', () => ({
  useJsonPatchWsStream: vi.fn(() => ({
    data: undefined,
    isConnected: true,
    isInitialized: true,
    error: null,
  })),
}));
vi.mock('@/shared/lib/api', () => ({
  scratchApi: {
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    getStreamUrl: (type: string, id: string) =>
      `/api/scratch/${type}/${id}/stream/ws`,
  },
}));

const update: UpdateScratch = {
  payload: { type: 'DRAFT_FOLLOW_UP', data: {} },
} as unknown as UpdateScratch;
let dom: ReturnType<typeof installDomlessReact>;
const scratches = new Map<string, UseScratchResult>();

function Probe({
  id,
  scratchId,
  ownerHostId,
}: {
  id: string;
  scratchId: string;
  /** Set when the scratch names its own keeper instead of the pane's host. */
  ownerHostId?: string | null;
}) {
  scratches.set(
    id,
    useScratch(
      ScratchType.DRAFT_FOLLOW_UP,
      scratchId,
      ownerHostId === undefined ? undefined : { hostId: ownerHostId }
    )
  );
  return null;
}
async function render() {
  await dom.render(
    <>
      {/* App root: no host scope, i.e. this machine. */}
      <Probe id="root" scratchId="preferences" />
      <HostIdContext.Provider value="host-b">
        <Probe id="pane-b" scratchId="session-b" />
        {/* Account data shown in a pane on host B: kept on this machine. */}
        <Probe id="account-draft" scratchId="issue" ownerHostId={null} />
      </HostIdContext.Provider>
      <HostIdContext.Provider value={null}>
        <Probe id="pane-local" scratchId="session-local" />
      </HostIdContext.Provider>
    </>
  );
}

beforeEach(async () => {
  dom = installDomlessReact();
  focused.hostId = 'host-focused';
  vi.mocked(scratchApi.update).mockClear();
  vi.mocked(scratchApi.delete).mockClear();
  vi.mocked(useJsonPatchWsStream).mockClear();
  await render();
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

describe('scratch owner', () => {
  it.each([
    ['root', 'preferences', null],
    ['pane-b', 'session-b', 'host-b'],
    ['pane-local', 'session-local', null],
    ['account-draft', 'issue', null],
  ])(
    'writes %s scratch to the host it is read from, not to the focused pane',
    async (id, scratchId, hostId) => {
      for (const focusedHost of ['host-focused', 'host-b', null]) {
        focused.hostId = focusedHost;
        await scratches.get(id)!.updateScratch(update);
        expect(scratchApi.update).toHaveBeenLastCalledWith(
          ScratchType.DRAFT_FOLLOW_UP,
          scratchId,
          update,
          hostId
        );
        await scratches.get(id)!.deleteScratch();
        expect(scratchApi.delete).toHaveBeenLastCalledWith(
          ScratchType.DRAFT_FOLLOW_UP,
          scratchId,
          hostId
        );
      }
    }
  );

  it('streams each scratch from that same host', () => {
    const targets = vi
      .mocked(useJsonPatchWsStream)
      .mock.calls.map(([endpoint, , , options]) => [
        endpoint,
        options?.targetHostId,
      ]);
    expect(targets).toEqual(
      expect.arrayContaining([
        ['/api/scratch/DRAFT_FOLLOW_UP/preferences/stream/ws', null],
        ['/api/scratch/DRAFT_FOLLOW_UP/session-b/stream/ws', 'host-b'],
        ['/api/scratch/DRAFT_FOLLOW_UP/session-local/stream/ws', null],
        // Rendered in a pane on host B, kept on this machine.
        ['/api/scratch/DRAFT_FOLLOW_UP/issue/stream/ws', null],
      ])
    );
  });
});
