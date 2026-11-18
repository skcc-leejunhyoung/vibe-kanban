import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawerArtifactDocument } from 'shared/types';
import { DrawerArtifact } from './DrawerArtifact';
import { buildArtifactPreview } from './artifact-preview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { time?: string }) =>
      options?.time ? `${key} ${options.time}` : key,
  }),
}));
vi.mock('./artifact-preview', () => ({
  buildArtifactPreview: vi.fn(() => ({
    srcDoc: '<html><body>Synthetic dashboard</body></html>',
    warnings: [],
  })),
}));
vi.mock('@/shared/lib/api', () => ({
  drawerArtifactsApi: { document: vi.fn(), snapshot: vi.fn() },
  ownedArtifactsApi: { document: vi.fn(), snapshot: vi.fn() },
}));
const clients: QueryClient[] = [];
const source =
  '<style>body{margin:8px;padding:16px}' +
  '.card{box-sizing:border-box;height:220px;width:220px;padding:0;color:navy}' +
  '.chart{height:100%;width:100%}</style>' +
  '<article class="card"><svg class="chart"></svg></article>';
const document: DrawerArtifactDocument = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  note_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Synthetic dashboard',
  path: 'dashboard.html',
  version: 'synthetic-version',
  files: [
    {
      path: 'dashboard.html',
      mime: 'text/html',
      bytes: [...new TextEncoder().encode(source)],
    },
  ],
};
function render(archived = false, documentNoteId = document.note_id!) {
  const client = new QueryClient();
  clients.push(client);
  client.setQueryData(
    [
      'drawer-artifact-document',
      'synthetic-host',
      document.note_id!,
      document.id,
    ],
    { ...document, note_id: documentNoteId }
  );
  client.setQueryData(
    [
      'drawer-artifact-data',
      'synthetic-host',
      document.note_id!,
      document.id,
      document.version,
    ],
    {
      data: { count: 5 },
      revision: 1,
      updated_at: '2030-01-01T00:00:00Z',
      request: null,
    }
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DrawerArtifact
        id={document.id}
        noteId={document.note_id!}
        hostId="synthetic-host"
        archived={archived}
      />
    </QueryClientProvider>
  );
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.clearAllMocks();
});
describe('Drawer read-only dashboard', () => {
  it('uses the isolated content-height frame with no submission capability or path header', () => {
    const html = render();
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('scrolling="no"');
    expect(html).not.toContain('dashboard.html');
    expect(html).not.toContain('<button');
    expect(vi.mocked(buildArtifactPreview).mock.calls[0][4]).toMatchObject({
      actions: [],
      initial: { editable: false },
    });
  });
  it('passes authored dashboard HTML unchanged so padding cannot resize charts', () => {
    render();
    const previewSource = vi.mocked(buildArtifactPreview).mock.calls[0][0];
    expect(previewSource).toBe(source);
  });
  it('shows the last update time in KST', () => {
    expect(render()).toContain(
      `artifacts.drawer.updated ${new Date('2030-01-01T00:00:00Z').toLocaleTimeString(undefined, { timeZone: 'Asia/Seoul' })}`
    );
  });
  it('shows an archived note as paused while keeping its frozen document', () => {
    const html = render(true);
    expect(html).toContain('<iframe');
    expect(html).toContain('artifacts.drawer.paused');
    expect(html).not.toContain('artifacts.input.check');
  });
  it('rejects a document bound to another Drawer note', () => {
    const html = render(false, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(html).toContain('artifacts.drawer.unavailable');
    expect(html).not.toContain('<iframe');
    expect(buildArtifactPreview).not.toHaveBeenCalled();
  });
  it('renders a transferred workspace document using its exact workspace and session ownership', () => {
    const workspace = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const session = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const client = new QueryClient();
    clients.push(client);
    const key = `${workspace}:${session}`;
    const moved = {
      ...document,
      note_id: null,
      workspace_id: workspace,
      session_id: session,
    };
    client.setQueryData(
      ['drawer-artifact-document', 'synthetic-host', key, document.id],
      moved
    );
    const renderWorkspace = () =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <DrawerArtifact
            id={document.id}
            workspaceId={workspace}
            sessionId={session}
            hostId="synthetic-host"
            archived={false}
          />
        </QueryClientProvider>
      );
    expect(renderWorkspace()).toContain('sandbox="allow-scripts"');
    expect(vi.mocked(buildArtifactPreview).mock.calls[0][0]).toBe(source);
    for (const mismatch of [
      { workspace_id: document.id },
      { session_id: document.id },
      { note_id: document.note_id },
    ]) {
      client.setQueryData(
        ['drawer-artifact-document', 'synthetic-host', key, document.id],
        { ...moved, ...mismatch }
      );
      expect(renderWorkspace()).not.toContain('<iframe');
    }
  });
});
