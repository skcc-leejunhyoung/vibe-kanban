import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorConfig } from 'shared/types';
import { useSessionSend } from './useSessionSend';
import { queueStatusQueryKey } from './useSessionQueueInteraction';

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
    sessionsApi: { followUp: vi.fn() },
    queueApi: { queue: vi.fn() },
  };
});
vi.mock('@/shared/lib/api', () => api);

const config = { executor: 'CLAUDE_CODE' } as ExecutorConfig;
const queued = {
  status: 'queued',
  messages: [{ id: 'q1', data: { message: 'hi', executor_config: config } }],
};
let root: Root;
let queryClient: QueryClient;
let hook: ReturnType<typeof useSessionSend>;

function Probe() {
  hook = useSessionSend({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    executorConfig: config,
  });
  return null;
}

beforeEach(() => {
  api.sessionsApi.followUp.mockReset();
  api.queueApi.queue.mockReset().mockResolvedValue(queued);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const document = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document,
      HTMLIFrameElement: class {},
    })
  );
  queryClient = new QueryClient();
  root = createRoot(
    Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: 'DIV',
      ownerDocument: document,
    }) as unknown as HTMLElement
  );
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('useSessionSend while the previous turn finishes', () => {
  it('queues the message instead of failing', async () => {
    api.sessionsApi.followUp.mockRejectedValue(
      new api.ApiError('still finishing', 423)
    );

    let result: unknown;
    await act(async () => {
      result = await hook.send('  hi  ');
    });

    expect(result).toBeNull();
    expect(api.queueApi.queue).toHaveBeenCalledWith(
      'session-a',
      { message: 'hi', executor_config: config },
      null
    );
    expect(
      queryClient.getQueryData(queueStatusQueryKey('session-a', null))
    ).toEqual(queued);
    expect(hook.error).toBeNull();
  });

  it('still refuses a turn that is really running', async () => {
    api.sessionsApi.followUp.mockRejectedValue(
      new api.ApiError('Another turn started', 409)
    );

    await act(async () => {
      await expect(hook.send('hi')).rejects.toThrow(
        'Failed to send: Another turn started'
      );
    });

    expect(api.queueApi.queue).not.toHaveBeenCalled();
    expect(hook.error).toBe('Failed to send: Another turn started');
  });

  it('reports a queue failure as the send failure', async () => {
    api.sessionsApi.followUp.mockRejectedValue(
      new api.ApiError('still finishing', 423)
    );
    api.queueApi.queue.mockRejectedValue(new Error('queue down'));

    await act(async () => {
      await expect(hook.send('hi')).rejects.toThrow(
        'Failed to send: queue down'
      );
    });
  });
});
