import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { ArtifactReference } from 'shared/types';
import DisplayConversationEntry from './DisplayConversationEntry';

const state = vi.hoisted(() => ({ managed: vi.fn(), legacy: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/hooks/useUserSystem', () => ({
  useUserSystem: () => ({ capabilities: {} }),
}));
vi.mock('@/shared/hooks/useChangesView', () => ({
  useChangesViewActions: () => ({}),
}));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => 'synthetic-host',
}));
vi.mock('../model/contexts/MessageEditContext', () => ({
  useMessageEditContext: () => ({ isEntryGreyed: () => false }),
}));
vi.mock('../model/hooks/useLiveStatus', () => ({
  useWritingStatusKey: () => undefined,
}));
vi.mock('@/shared/components/WYSIWYGEditor', () => ({
  default: ({ value }: { value: string }) => <div>{value}</div>,
}));
vi.mock('@/shared/dialogs/scripts/ScriptFixerDialog', () => ({
  ScriptFixerDialog: {},
}));
vi.mock('./ArtifactCards', () => ({
  useExecutionArtifacts: () => ({ data: { artifacts: [] } }),
  ArtifactCards: (props: { artifacts: ArtifactReference[] }) => {
    state.legacy(props);
    return null;
  },
}));
vi.mock('./DrawerArtifact', () => ({
  DrawerArtifact: (props: object) => {
    state.managed(props);
    return <figure data-managed="true" />;
  },
}));

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const line = `[Dashboard](drawer-artifacts/${id} "vibe-artifact")`;
type Props = ComponentProps<typeof DisplayConversationEntry>;
function render(
  content: string,
  overrides: ArtifactReference[] = [],
  archived = false
) {
  const workspace = {
    id: 'synthetic-workspace',
    session: { id: 'synthetic-session' },
    archived,
  } as Props['workspaceWithSession'];
  return renderToStaticMarkup(
    <DisplayConversationEntry
      expansionKey="synthetic-process:0"
      executionProcessId="synthetic-process"
      workspaceWithSession={workspace}
      resetAction={{} as Props['resetAction']}
      repos={[]}
      entry={{
        entry_type: { type: 'assistant_message' },
        content,
        timestamp: null,
      }}
      aggregatedGroup={null}
      aggregatedDiffGroup={null}
      aggregatedThinkingGroup={null}
      artifactOverrides={overrides}
    />
  );
}
afterEach(() => vi.clearAllMocks());

it('renders a managed dashboard exactly at its explicit assistant attachment line', () => {
  const html = render(`Before\n${line}\nAfter`);
  expect(html.indexOf('Before')).toBeLessThan(html.indexOf('data-managed'));
  expect(html.indexOf('data-managed')).toBeLessThan(html.indexOf('After'));
  expect(state.managed).toHaveBeenCalledWith({
    id,
    workspaceId: 'synthetic-workspace',
    sessionId: 'synthetic-session',
    hostId: 'synthetic-host',
    archived: false,
  });
});

it.each([
  '',
  'Ordinary reply',
  `[Dashboard](drawer-artifacts/${id})`,
  `\`\`\`text\n${line}\n\`\`\``,
  `> ${line}`,
  '[Dashboard](drawer-artifacts/invalid "vibe-artifact")',
])(
  'does not display a managed artifact without an explicit valid attachment: %s',
  (content) => {
    expect(render(content)).not.toContain('data-managed');
    expect(state.managed).not.toHaveBeenCalled();
  }
);

it('keeps archive state and resolves a managed reference ahead of a stale disk observation', () => {
  const legacy = {
    id: 'synthetic-file-observation',
    path: `drawer-artifacts/${id}`,
  } as ArtifactReference;
  expect(render(line, [legacy], true)).toContain('data-managed');
  expect(state.managed.mock.calls[0][0]).toMatchObject({ archived: true });
  expect(
    state.legacy.mock.calls.every(([props]) => props.artifacts.length === 0)
  ).toBe(true);
});
