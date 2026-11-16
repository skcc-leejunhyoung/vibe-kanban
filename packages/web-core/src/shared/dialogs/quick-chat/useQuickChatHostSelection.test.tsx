import { act, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import type { AppRuntime } from '@/shared/hooks/useAppRuntime';
import { useQuickChatHostSelection } from './useQuickChatHostSelection';

interface Props {
  visible: boolean;
  runtime: AppRuntime;
  routeHostId: string | null;
  firstOnlineHostId: string | null;
  hasDraft: boolean;
}

let dom: ReturnType<typeof installDomlessReact>;
let selected: string | null;
let select: (hostId: string | null) => void;
let props: Props;

/** What React committed, i.e. what a host panel would have been mounted for. */
let committed: { visible: boolean; selected: string | null }[];

function Probe(current: Props) {
  const [value, setValue] = useQuickChatHostSelection(current);
  selected = value;
  select = setValue;
  useEffect(() => {
    committed.push({ visible: current.visible, selected: value });
  });
  return null;
}
async function render(patch: Partial<Props> = {}) {
  props = { ...props, ...patch };
  await dom.render(<Probe {...props} />);
}

beforeEach(() => {
  dom = installDomlessReact();
  committed = [];
  props = {
    visible: false,
    runtime: 'local',
    routeHostId: null,
    firstOnlineHostId: null,
    hasDraft: false,
  };
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

describe('quick chat host selection', () => {
  it('opens on the host of the focused pane', async () => {
    await render({ routeHostId: 'host-b' });
    await render({ visible: true });
    expect(selected).toBe('host-b');
  });

  it('ignores pane focus changes behind the open dialog', async () => {
    await render({ visible: true });
    expect(selected).toBeNull();
    for (const focusedHost of ['host-b', null, 'host-c']) {
      await render({ routeHostId: focusedHost });
      expect(selected).toBeNull();
    }
  });

  it('keeps an explicit pick while other panes take focus', async () => {
    await render({ visible: true, routeHostId: 'host-b' });
    await act(() => select(null));
    await render({ routeHostId: 'host-c' });
    await render({ routeHostId: 'host-b' });
    expect(selected).toBeNull();
  });

  it('follows the focused pane again on the next empty open', async () => {
    await render({ visible: true });
    await render({ visible: false });
    await render({ routeHostId: 'host-b' });
    expect(selected).toBeNull();
    await render({ visible: true });
    expect(selected).toBe('host-b');
  });

  it('never shows the previous host when reopened from another pane', async () => {
    await render({ visible: true, routeHostId: 'host-b' });
    await render({ visible: false });
    await render({ routeHostId: 'host-c' });
    committed = [];
    await render({ visible: true });
    // Not even for one commit: that would mount host B's panel and send B a
    // round of requests for a dialog opened on C.
    expect(committed.filter((c) => c.visible).map((c) => c.selected)).toEqual([
      'host-c',
    ]);
  });

  it('keeps a draft on the host it was written for across a reopen', async () => {
    await render({ visible: true });
    await render({ hasDraft: true });
    await render({ visible: false });
    await render({ routeHostId: 'host-b' });
    await render({ visible: true });
    expect(selected).toBeNull();
    // Sent or cleared: the next open is free to follow the pane again.
    await render({ visible: false, hasDraft: false });
    await render({ visible: true });
    expect(selected).toBe('host-b');
  });

  it('defaults the remote web to the first online host once the list arrives', async () => {
    await render({ runtime: 'remote', visible: true });
    expect(selected).toBeNull();
    await render({ firstOnlineHostId: 'host-a' });
    expect(selected).toBe('host-a');
    // A later list order change does not replace it.
    await render({ firstOnlineHostId: 'host-b' });
    expect(selected).toBe('host-a');
  });

  it('reopens a host-less remote page on the default host without passing through none', async () => {
    await render({ runtime: 'remote', firstOnlineHostId: 'host-a' });
    await render({ visible: true });
    expect(selected).toBe('host-a');
    await render({ visible: false });
    committed = [];
    await render({ visible: true });
    // A `null` commit would key the host draft to "no host" and drop the
    // folder and model picked for host A.
    expect(committed.filter((c) => c.visible).map((c) => c.selected)).toEqual([
      'host-a',
    ]);
  });

  it('does not replace a remote route host that happens to be offline', async () => {
    await render({ runtime: 'remote', routeHostId: 'host-b' });
    await render({ visible: true, firstOnlineHostId: 'host-a' });
    expect(selected).toBe('host-b');
  });

  it('never defaults the local web away from this machine', async () => {
    await render({ visible: true, firstOnlineHostId: 'host-a' });
    expect(selected).toBeNull();
  });
});
