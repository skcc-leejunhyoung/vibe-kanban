import { renderToStaticMarkup } from 'react-dom/server';
import {
  QueryClient,
  QueryObserver,
  type QueryObserverOptions,
} from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DrawerArtifact } from './DrawerArtifact';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', new EventTarget());
  return {
    options: [] as unknown[],
    document: vi.fn(),
    client: null as unknown,
  };
});
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQuery: (options: unknown) => {
    state.options.push(options);
    return { data: undefined, error: null, isError: false };
  },
  useQueryClient: () => state.client,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/lib/api', () => ({
  drawerArtifactsApi: { document: state.document, snapshot: vi.fn() },
  ownedArtifactsApi: { document: state.document, snapshot: vi.fn() },
}));
let client: QueryClient;
let unsubscribe: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  state.client = client;
  state.options = [];
  state.document.mockReset();
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  client.clear();
  vi.useRealTimers();
});
function observeDocument() {
  renderToStaticMarkup(
    <DrawerArtifact
      id="synthetic-artifact"
      noteId="synthetic-note"
      hostId={null}
      archived={false}
    />
  );
  const observer = new QueryObserver(
    client,
    state.options[0] as QueryObserverOptions
  );
  unsubscribe = observer.subscribe(() => {});
  return observer;
}
it('polls a pending document until the move completes, then stops polling', async () => {
  state.document
    .mockRejectedValueOnce(
      Object.assign(new Error('Transfer pending'), { statusCode: 409 })
    )
    .mockResolvedValue({ version: 'synthetic-completed-version' });
  const observer = observeDocument();
  await vi.advanceTimersByTimeAsync(1);
  expect(observer.getCurrentResult().isError).toBe(true);
  await vi.advanceTimersByTimeAsync(2100);
  expect(state.document).toHaveBeenCalledTimes(2);
  expect(observer.getCurrentResult().data).toEqual({
    version: 'synthetic-completed-version',
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(state.document).toHaveBeenCalledTimes(2);
});
it('keeps actual ownership denials terminal instead of retrying them', async () => {
  state.document.mockRejectedValue(
    Object.assign(new Error('Forbidden'), { statusCode: 403 })
  );
  const observer = observeDocument();
  await vi.advanceTimersByTimeAsync(30000);
  expect(observer.getCurrentResult().isError).toBe(true);
  expect(state.document).toHaveBeenCalledTimes(1);
});
