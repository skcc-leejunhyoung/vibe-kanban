import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { HostIdContext, useHostIdPinnedWhile } from './HostIdProvider';

vi.mock('@/shared/hooks/useCurrentAppDestination', () => ({
  useCurrentAppDestination: () => null,
}));

let dom: ReturnType<typeof installDomlessReact>;
let pinned: string | null;

function Probe({ open }: { open: boolean }) {
  pinned = useHostIdPinnedWhile(open);
  return null;
}
/** `documentHost` is the focused pane's host; `open` the dialog's visibility. */
const render = (documentHost: string | null, open: boolean) =>
  dom.render(
    <HostIdContext.Provider value={documentHost}>
      <Probe open={open} />
    </HostIdContext.Provider>
  );

beforeEach(() => {
  dom = installDomlessReact();
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

describe('a dialog’s host while it is open', () => {
  it('stays the host it was opened on when another pane takes focus', async () => {
    await render('host-a', false);
    await render('host-a', true);
    expect(pinned).toBe('host-a');
    await render('host-b', true);
    await render(null, true);
    expect(pinned).toBe('host-a');
  });

  it('takes the host of the moment on every open', async () => {
    await render('host-a', true);
    await render('host-a', false);
    await render('host-b', false);
    // Closed, it follows the document, so nothing stale is carried along.
    expect(pinned).toBe('host-b');
    await render('host-b', true);
    expect(pinned).toBe('host-b');
    await render('host-a', true);
    expect(pinned).toBe('host-b');
  });
});
