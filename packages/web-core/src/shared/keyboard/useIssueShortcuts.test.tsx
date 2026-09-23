import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { useIssueShortcuts } from './useIssueShortcuts';

const { hotkeys, grid } = vi.hoisted(() => ({
  hotkeys:
    vi.fn<
      (keys: string, cb: unknown, options?: { enabled?: boolean }) => void
    >(),
  grid: { targeted: false },
}));

vi.mock('react-hotkeys-hook', () => ({ useHotkeys: hotkeys }));
vi.mock('@/shared/hooks/useActions', () => ({
  useActions: () => ({ executeAction: () => {} }),
}));
vi.mock('@/shared/actions', () => ({ Actions: {} }));
vi.mock('@/shared/types/actions', () => ({
  ActionTargetType: { ISSUE: 'issue', NONE: 'none' },
}));
vi.mock('@/shared/hooks/useCurrentAppDestination', () => ({
  useCurrentAppDestination: () => ({ kind: 'project', projectId: 'p1' }),
}));
vi.mock('@/shared/hooks/useCurrentKanbanRouteState', () => ({
  useCurrentKanbanRouteState: () => ({ isCreateMode: false }),
}));
vi.mock('@/shared/stores/useKeyboardShortcutsStore', () => ({
  useKeyboardShortcutsStore: (
    selector: (s: { overrides: Record<string, string> }) => unknown
  ) => selector({ overrides: {} }),
}));
vi.mock('@/shared/lib/openInSplitPane', () => ({
  useIsPaneGridTargeted: () => grid.targeted,
}));

function Probe() {
  useIssueShortcuts();
  return null;
}

async function renderProbe() {
  const dom = installDomlessReact();
  await dom.render(<Probe />);
  return dom;
}

function rangeSelectEnabled(): boolean | undefined {
  return hotkeys.mock.calls.find(
    ([keys]) => keys === 'shift+j, shift+down'
  )?.[2]?.enabled;
}

describe('useIssueShortcuts', () => {
  let dom: ReturnType<typeof installDomlessReact> | undefined;

  afterEach(async () => {
    await dom?.unmount();
    hotkeys.mockClear();
  });

  it('answers Shift+Arrow on the project page', async () => {
    grid.targeted = false;
    dom = await renderProbe();

    expect(rangeSelectEnabled()).toBe(true);
  });

  it('goes inert while the pane grid targets an active pane', async () => {
    // The document URL mirrors the active pane, so this document-level
    // instance would otherwise fire alongside the pane's own instance.
    grid.targeted = true;
    dom = await renderProbe();

    expect(rangeSelectEnabled()).toBe(false);
  });
});
