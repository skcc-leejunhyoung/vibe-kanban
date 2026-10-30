import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ArtifactAutomationResult,
  ArtifactAutomationSnapshot,
  ArtifactInteraction,
} from 'shared/types';
import { useArtifactAutomation } from './useArtifactAutomation';

const api = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      public status?: number
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    artifactsApi: { automationSnapshot: vi.fn(), automationRequest: vi.fn() },
  };
});
vi.mock('@/shared/lib/api', () => api);

let root: Root;
let client: QueryClient;
let hook: ReturnType<typeof useArtifactAutomation>;
let interaction: ArtifactInteraction;
let latest: ArtifactAutomationSnapshot;
let records: Map<string, ArtifactAutomationResult>;
let readOnly: boolean;
function Probe() {
  hook = useArtifactAutomation(interaction, 'fixture-host', readOnly);
  return null;
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function request() {
  await act(async () => {
    hook.request('refresh', {});
  });
  await flush();
}
async function check() {
  await act(async () => {
    await hook.check();
  });
  await flush();
}

beforeEach(async () => {
  readOnly = false;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const document = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), { document, HTMLIFrameElement: class {} })
  );
  interaction = {
    reference: {
      request_id: crypto.randomUUID(),
      session_id: 'fixture-session',
      execution_id: 'fixture-process',
    },
    workspace_id: 'fixture-workspace',
    owner_host: 'fixture-host',
    owner_id: 'fixture-owner',
    artifact_id: 'dashboard',
    artifact_hash: 'fixture-hash',
    version: 'fixture-version',
    schema: { type: 'object', properties: {}, required: [] },
    delivery: 'automation',
    handler: null,
    state: 'input_required',
    created_at: '2025-01-01T00:00:00Z',
    expires_at: '2025-01-01T10:00:00Z',
    result_process_id: null,
    error: null,
    automation: {
      channel_id: 'dashboard',
      version: 'a'.repeat(64),
      data_schema: { type: 'object', properties: {}, required: [] },
      actions: {
        refresh: {
          label: 'Refresh',
          schema: { type: 'object', properties: {}, required: [] },
        },
      },
    },
  };
  records = new Map();
  latest = { data: { count: 1 }, revision: 1, updated_at: null, request: null };
  api.artifactsApi.automationSnapshot
    .mockReset()
    .mockImplementation(async (_interaction, _host, id) =>
      structuredClone({
        ...latest,
        request: id ? (records.get(id) ?? null) : latest.request,
      })
    );
  api.artifactsApi.automationRequest
    .mockReset()
    .mockImplementation(async (_interaction, input) => {
      if (!records.has(input.request_id))
        records.set(input.request_id, {
          request_id: input.request_id,
          action: input.action,
          status: 'completed',
          message: null,
        });
      latest = { ...latest, request: records.get(input.request_id)! };
      return structuredClone(latest.request);
    });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  root = createRoot(
    Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: 'DIV',
      ownerDocument: document,
    }) as unknown as HTMLElement
  );
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe))
    );
  });
  await flush();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  client.clear();
  vi.unstubAllGlobals();
});

describe('artifact automation request state', () => {
  it('does not refetch or restore dashboard data when an action returns after archival', async () => {
    let finish: (result: unknown) => void;
    api.artifactsApi.automationRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await request();
    readOnly = true;
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(Probe))
      );
    });
    const reads = api.artifactsApi.automationSnapshot.mock.calls.length;
    await act(async () => {
      finish!({ status: 'completed' });
    });
    await flush();
    expect(api.artifactsApi.automationSnapshot).toHaveBeenCalledTimes(reads);
    expect(api.artifactsApi.automationRequest).toHaveBeenCalledTimes(1);
    expect(hook.snapshot).toBeUndefined();
    expect(hook.retry).toBeUndefined();
  });
  it('stops reads and rejects further actions when the workspace becomes read-only', async () => {
    readOnly = true;
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(Probe))
      );
    });
    await request();
    expect(hook.connected).toBe(false);
    expect(hook.editable).toBe(false);
    expect(hook.retry).toBeUndefined();
    expect(api.artifactsApi.automationRequest).not.toHaveBeenCalled();
  });
  it('reads the latest operation after a completed request, including work from another screen', async () => {
    expect(hook.connected).toBe(true);
    await request();
    expect(hook.current?.status).toBe('completed');
    latest.request = {
      request_id: crypto.randomUUID(),
      action: 'refresh',
      status: 'accepted',
      message: null,
    };
    await check();
    expect(hook.current).toEqual(latest.request);
    expect(hook.busy).toBe(true);
    expect(hook.editable).toBe(false);
    expect(
      api.artifactsApi.automationSnapshot.mock.calls.every(
        (call) => call[2] === undefined
      )
    ).toBe(true);
  });

  it('keeps the same ID on explicit retry after a lost response without replaying its work', async () => {
    const submit = api.artifactsApi.automationRequest.getMockImplementation()!;
    api.artifactsApi.automationRequest.mockImplementationOnce(
      async (...args) => {
        await submit(...args);
        throw new Error('Response lost');
      }
    );
    await request();
    expect(hook.uncertain).toBe(true);
    expect(hook.editable).toBe(false);
    expect(api.artifactsApi.automationRequest).toHaveBeenCalledTimes(1);
    await act(async () => {
      await hook.retry?.();
    });
    await flush();
    const calls = api.artifactsApi.automationRequest.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1].request_id).toBe(calls[1][1].request_id);
    expect(records.size).toBe(1);
    expect(hook.uncertain).toBe(false);
    expect(hook.retry).toBeUndefined();
    expect(hook.current?.status).toBe('completed');
  });

  it('checks an uncertain receipt explicitly, then resumes latest-operation reads', async () => {
    const submit = api.artifactsApi.automationRequest.getMockImplementation()!;
    api.artifactsApi.automationRequest.mockImplementationOnce(
      async (...args) => {
        await submit(...args);
        throw new Error('Response lost');
      }
    );
    await request();
    const id = api.artifactsApi.automationRequest.mock.calls[0][1].request_id;
    await check();
    expect(
      api.artifactsApi.automationSnapshot.mock.calls.some(
        (call) => call[2] === id
      )
    ).toBe(true);
    expect(
      api.artifactsApi.automationSnapshot.mock.lastCall?.[2]
    ).toBeUndefined();
    expect(hook.uncertain).toBe(false);
    expect(hook.retry).toBeUndefined();
    expect(api.artifactsApi.automationRequest).toHaveBeenCalledTimes(1);
    latest.request = {
      request_id: crypto.randomUUID(),
      action: 'refresh',
      status: 'processing',
      message: null,
    };
    await check();
    expect(hook.current).toEqual(latest.request);
    expect(hook.busy).toBe(true);
  });

  it('keeps an unreceived request uncertain until the user retries it', async () => {
    api.artifactsApi.automationRequest.mockRejectedValueOnce(
      new Error('Connection lost before receipt')
    );
    await request();
    await check();
    expect(hook.uncertain).toBe(true);
    expect(hook.retry).toBeDefined();
    expect(hook.editable).toBe(false);
    expect(api.artifactsApi.automationRequest).toHaveBeenCalledTimes(1);
  });

  it('refreshes a conflict from another screen without offering to retry rejected work', async () => {
    latest.request = {
      request_id: crypto.randomUUID(),
      action: 'refresh',
      status: 'accepted',
      message: null,
    };
    api.artifactsApi.automationRequest.mockRejectedValueOnce(
      new api.ApiError('Already running', 409)
    );
    await request();
    expect(hook.current).toEqual(latest.request);
    expect(hook.busy).toBe(true);
    expect(hook.uncertain).toBe(false);
    expect(hook.retry).toBeUndefined();
    expect(hook.error).toBe('Already running');
  });

  it('keeps actions disabled if the post-acceptance status read fails and only resumes on a check', async () => {
    const submit = api.artifactsApi.automationRequest.getMockImplementation()!;
    api.artifactsApi.automationRequest.mockImplementationOnce(
      async (...args) => {
        const response = await submit(...args);
        api.artifactsApi.automationSnapshot.mockRejectedValueOnce(
          new Error('Status unavailable')
        );
        return response;
      }
    );
    await request();
    expect(hook.connected).toBe(false);
    expect(hook.editable).toBe(false);
    expect(hook.uncertain).toBe(false);
    expect(hook.error).toBe('Status unavailable');
    await check();
    expect(hook.connected).toBe(true);
    expect(hook.current?.status).toBe('completed');
    expect(api.artifactsApi.automationRequest).toHaveBeenCalledTimes(1);
  });
});
