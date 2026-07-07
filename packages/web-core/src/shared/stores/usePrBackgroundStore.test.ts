import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the API layer so no network call can fire; the store is the unit here.
vi.mock('@/shared/lib/api', () => ({
  workspacesApi: {
    generatePrDescription: vi.fn(),
    createPR: vi.fn(),
  },
}));

import { usePrBackgroundStore } from './usePrBackgroundStore';
import { workspacesApi } from '@/shared/lib/api';

const generatePrDescription = vi.mocked(workspacesApi.generatePrDescription);
const createPR = vi.mocked(workspacesApi.createPR);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const genReq = {
  repo_id: 'repo1',
  target_branch: null,
  head_branch: null,
};
const createReq = {
  title: 'PR title',
  body: null,
  target_branch: 'main',
  head_branch: null,
  draft: false,
  repo_id: 'repo1',
};

describe('usePrBackgroundStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePrBackgroundStore.setState({ byWorkspace: {} });
  });

  it('applies a successful generation result to the workspace entry', async () => {
    generatePrDescription.mockResolvedValue({ title: 'T', description: 'D' });

    usePrBackgroundStore.getState().startGenerate('ws-gen-ok', genReq);
    expect(
      usePrBackgroundStore.getState().byWorkspace['ws-gen-ok']?.generate?.status
    ).toBe('running');

    await flush();

    expect(
      usePrBackgroundStore.getState().byWorkspace['ws-gen-ok']?.generate
    ).toEqual({ status: 'success', title: 'T', description: 'D' });
  });

  it('does not start a second generation while one is running', () => {
    generatePrDescription.mockReturnValue(new Promise(() => {}));

    const store = usePrBackgroundStore.getState();
    store.startGenerate('ws-gen-dup', genReq);
    store.startGenerate('ws-gen-dup', genReq);

    expect(generatePrDescription).toHaveBeenCalledTimes(1);
  });

  it('aborts and clears a running generation on cancel', async () => {
    let captured: AbortSignal | undefined;
    generatePrDescription.mockImplementation((_id, _req, signal) => {
      captured = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    });

    const store = usePrBackgroundStore.getState();
    store.startGenerate('ws-gen-cancel', genReq);
    store.cancelGenerate('ws-gen-cancel');

    expect(captured?.aborted).toBe(true);
    expect(
      usePrBackgroundStore.getState().byWorkspace['ws-gen-cancel']?.generate
    ).toBeUndefined();

    // The AbortError rejection must not resurface as an error state.
    await flush();
    expect(
      usePrBackgroundStore.getState().byWorkspace['ws-gen-cancel']?.generate
    ).toBeUndefined();
  });

  it('records a finished PR creation as done with its result', async () => {
    createPR.mockResolvedValue({ success: true, data: 'https://pr' });

    usePrBackgroundStore.getState().startCreate('ws-create-ok', createReq);
    expect(
      usePrBackgroundStore.getState().byWorkspace['ws-create-ok']?.create
        ?.status
    ).toBe('running');

    await flush();

    const create =
      usePrBackgroundStore.getState().byWorkspace['ws-create-ok']?.create;
    expect(create?.status).toBe('done');
    expect(create?.result).toEqual({ success: true, data: 'https://pr' });
    expect(create?.baseBranch).toBe('main');
  });

  it('aborts and clears a running PR creation on cancel', async () => {
    let captured: AbortSignal | undefined;
    createPR.mockImplementation((_id, _req, signal) => {
      captured = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    });

    const store = usePrBackgroundStore.getState();
    store.startCreate('ws-create-cancel', createReq);
    store.cancelCreate('ws-create-cancel');

    expect(captured?.aborted).toBe(true);
    expect(
      usePrBackgroundStore.getState().byWorkspace['ws-create-cancel']?.create
    ).toBeUndefined();

    await flush();
    expect(
      usePrBackgroundStore.getState().byWorkspace['ws-create-cancel']?.create
    ).toBeUndefined();
  });

  it('does not start a second PR creation while one is running', () => {
    createPR.mockReturnValue(new Promise(() => {}));

    const store = usePrBackgroundStore.getState();
    store.startCreate('ws-create-dup', createReq);
    store.startCreate('ws-create-dup', createReq);

    expect(createPR).toHaveBeenCalledTimes(1);
  });

  it('records a network throw as an error state', async () => {
    createPR.mockRejectedValue(new Error('boom'));

    usePrBackgroundStore.getState().startCreate('ws-create-err', createReq);
    await flush();

    const create =
      usePrBackgroundStore.getState().byWorkspace['ws-create-err']?.create;
    expect(create?.status).toBe('error');
    expect(create?.error).toBe('boom');
  });

  it('ignores the late resolution of a canceled-and-superseded creation', async () => {
    const resolvers: Array<(v: { success: true; data: string }) => void> = [];
    createPR.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );

    const store = usePrBackgroundStore.getState();
    store.startCreate('ws-stale', createReq); // controller #1
    store.cancelCreate('ws-stale'); // aborts #1, clears state
    store.startCreate('ws-stale', createReq); // controller #2, now running

    // The stale (first) request resolves late — it must not overwrite #2.
    resolvers[0]?.({ success: true, data: 'https://stale' });
    await flush();

    const create =
      usePrBackgroundStore.getState().byWorkspace['ws-stale']?.create;
    expect(create?.status).toBe('running');
    expect(createPR).toHaveBeenCalledTimes(2);
  });

  it('drops the workspace entry once both operations are cleared', async () => {
    generatePrDescription.mockResolvedValue({ title: 'T', description: 'D' });

    const store = usePrBackgroundStore.getState();
    store.startGenerate('ws-gc', genReq);
    await flush();
    expect(usePrBackgroundStore.getState().byWorkspace['ws-gc']).toBeDefined();

    store.clearGenerate('ws-gc');
    expect('ws-gc' in usePrBackgroundStore.getState().byWorkspace).toBe(false);
  });
});
