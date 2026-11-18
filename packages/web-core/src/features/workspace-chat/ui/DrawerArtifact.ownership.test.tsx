import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DrawerArtifact } from './DrawerArtifact';

const api = vi.hoisted(() => {
  vi.stubGlobal('window', new EventTarget());
  return { document: vi.fn(), snapshot: vi.fn() };
});
vi.mock('@/shared/hooks/auth/useAuth', () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    userId: 'synthetic-owner',
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/lib/api', () => ({
  drawerArtifactsApi: api,
  ownedArtifactsApi: api,
}));
vi.mock('./artifact-preview', () => ({
  buildArtifactPreview: () => ({ srcDoc: '<p>Synthetic dashboard</p>' }),
}));

let root: Root;
let client: QueryClient;
let view: ReactNode;
const owner = {
  workspaceId: 'synthetic-workspace',
  sessionId: 'synthetic-session',
};
const document = {
  id: 'synthetic-artifact',
  note_id: null,
  workspace_id: owner.workspaceId,
  session_id: owner.sessionId,
  name: 'Synthetic dashboard',
  path: 'index.html',
  version: 'synthetic-version',
  files: [{ path: 'index.html', mime: 'text/html', bytes: [] }],
};

// Run the real hooks; serialize the returned view without a browser DOM.
function Probe({ drawer = false }: { drawer?: boolean }) {
  view = DrawerArtifact({
    id: document.id,
    hostId: 'synthetic-host',
    archived: false,
    ...(drawer ? { noteId: 'synthetic-note' } : owner),
  });
  return null;
}

async function settle(milliseconds = 1) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
  for (let i = 0; i < 4; i++)
    await act(async () => vi.advanceTimersByTimeAsync(1));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const dom = Object.assign(new EventTarget(), {
    nodeType: 9,
    activeElement: null,
  });
  vi.stubGlobal('document', dom);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document: dom,
      HTMLIFrameElement: class {},
    })
  );
  root = createRoot(
    Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: 'DIV',
      ownerDocument: dom,
    }) as unknown as HTMLElement
  );
  client = new QueryClient();
  api.document.mockReset().mockResolvedValue(document);
  api.snapshot.mockReset().mockResolvedValue({
    data: { count: 5 },
    revision: 1,
    updated_at: null,
    request: null,
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function show(drawer = false) {
  if (drawer)
    api.document.mockResolvedValue({ ...document, note_id: 'synthetic-note' });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Probe, { drawer })
      )
    );
  });
  await settle();
  expect(renderToStaticMarkup(view)).toContain('<iframe');
}

it.each([false, true])(
  'removes a loaded dashboard and stops polling after ownership is revoked (drawer=%s)',
  async (drawer) => {
    await show(drawer);
    const denied = Object.assign(new Error('Ownership transferred'), {
      statusCode: 403,
    });
    api.document.mockRejectedValue(denied);
    api.snapshot.mockRejectedValue(denied);
    await settle(2100);
    expect(api.document).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(view)).not.toContain('<iframe');
    expect(renderToStaticMarkup(view)).toContain('Ownership transferred');
    const calls = api.snapshot.mock.calls.length;
    await settle(30000);
    expect(api.document).toHaveBeenCalledTimes(2);
    expect(api.snapshot).toHaveBeenCalledTimes(calls);
    api.document.mockResolvedValue({
      ...document,
      note_id: drawer ? 'synthetic-note' : null,
      version: 'synthetic-restored-version',
    });
    api.snapshot.mockResolvedValue({ data: { count: 6 }, revision: 2 });
    await act(async () => {
      await client.refetchQueries({ queryKey: ['drawer-artifact-document'] });
    });
    await settle();
    expect(renderToStaticMarkup(view)).toContain('<iframe');
    expect(api.snapshot).toHaveBeenCalledTimes(calls + 1);
  }
);

it('resumes the dashboard after a pending transfer resolves to a new document version', async () => {
  await show();
  const pending = Object.assign(new Error('Transfer pending'), {
    statusCode: 409,
  });
  api.document
    .mockRejectedValueOnce(pending)
    .mockResolvedValue({ ...document, version: 'synthetic-moved-version' });
  api.snapshot
    .mockRejectedValueOnce(pending)
    .mockResolvedValue({ data: { count: 6 }, revision: 2 });
  await settle(2100);
  expect(renderToStaticMarkup(view)).not.toContain('<iframe');
  await settle(2100);
  expect(renderToStaticMarkup(view)).toContain('<iframe');
  expect(api.snapshot.mock.lastCall?.[2]).toBe('synthetic-moved-version');
});

it('keeps the loaded dashboard on a temporary failure and resumes data polling', async () => {
  await show();
  api.snapshot.mockRejectedValue(
    Object.assign(new Error('Temporarily unavailable'), { statusCode: 503 })
  );
  await settle(2100);
  expect(renderToStaticMarkup(view)).toContain('<iframe');
  expect(api.document).toHaveBeenCalledTimes(1);
  const calls = api.snapshot.mock.calls.length;
  api.snapshot.mockResolvedValue({ data: { count: 6 }, revision: 2 });
  await settle(10100);
  expect(api.snapshot).toHaveBeenCalledTimes(calls + 1);
  expect(renderToStaticMarkup(view)).not.toContain(
    'artifacts.input.disconnected'
  );
});
