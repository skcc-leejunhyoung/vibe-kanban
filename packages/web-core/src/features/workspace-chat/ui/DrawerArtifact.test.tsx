import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawerArtifactDocument } from 'shared/types';
import { DrawerArtifact } from './DrawerArtifact';
import { buildArtifactPreview } from './artifact-preview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./artifact-preview', () => ({
  buildArtifactPreview: vi.fn(() => ({
    srcDoc: '<html><body>Synthetic dashboard</body></html>',
    warnings: [],
  })),
}));
vi.mock('@/shared/lib/api', () => ({
  drawerArtifactsApi: { document: vi.fn(), snapshot: vi.fn() },
}));
const clients: QueryClient[] = [];
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
      bytes: [...new TextEncoder().encode('<html></html>')],
    },
  ],
};
function render(archived = false, documentNoteId = document.note_id) {
  const client = new QueryClient();
  clients.push(client);
  client.setQueryData(
    [
      'drawer-artifact-document',
      'synthetic-host',
      document.note_id,
      document.id,
    ],
    { ...document, note_id: documentNoteId }
  );
  client.setQueryData(
    [
      'drawer-artifact-data',
      'synthetic-host',
      document.note_id,
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
        noteId={document.note_id}
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
});
