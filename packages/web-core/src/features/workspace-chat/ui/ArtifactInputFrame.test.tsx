import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactInteraction } from 'shared/types';
import { ArtifactInputFrame } from './ArtifactInputFrame';

vi.mock('@/shared/lib/api', () => ({ artifactsApi: {} }));
vi.mock('./useArtifactAutomation', () => ({
  useArtifactAutomation: () => ({}),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const interaction: ArtifactInteraction = {
  reference: {
    request_id: 'test-request',
    session_id: 'test-session',
    execution_id: 'test-execution',
  },
  workspace_id: 'test-workspace',
  owner_host: 'test-host',
  owner_id: 'test-owner',
  artifact_id: 'test-artifact',
  artifact_hash: 'test-hash',
  version: 'test-version',
  schema: { type: 'object', properties: {} },
  delivery: 'follow_up',
  handler: null,
  state: 'input_required',
  created_at: '2025-01-01T00:00:00Z',
  expires_at: '2025-01-01T10:00:00Z',
  result_process_id: null,
  error: null,
  automation: null,
};

function render(disconnected = false, readOnly = false) {
  return renderToStaticMarkup(
    <ArtifactInputFrame
      srcDoc="<p>Form</p>"
      channel="test-channel"
      interaction={interaction}
      hostId={null}
      title="artifact-name.html"
      refresh={async () => {}}
      updated={() => {}}
      disconnected={disconnected}
      readOnly={readOnly}
    />
  );
}

describe('inline artifact controls', () => {
  it('omits the visible path header and collapse controls while preserving accessibility and status', () => {
    const html = render();
    expect(html).toContain('title="artifact-name.html"');
    expect(html).not.toContain('>artifact-name.html<');
    expect(html).not.toContain('<button');
    expect(html).toContain('scrolling="no"');
    expect(html).not.toContain('h-[420px]');
    expect(html).not.toContain('75vh');
    expect(html).toContain('role="status"');
    expect(html).toContain('artifacts.input.noDraftStorage');
  });

  it('keeps host error and recovery controls outside the artifact', () => {
    const html = render(true);
    expect(html).toContain('role="alert"');
    expect(html).toContain('artifacts.input.disconnected');
    expect(html).toContain('artifacts.input.check');
  });

  it('makes archived inputs read-only and removes retry controls even with stale input state', () => {
    const html = render(true, true);
    expect(html).toContain('artifacts.input.expired');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('artifacts.input.noDraftStorage');
  });
});
