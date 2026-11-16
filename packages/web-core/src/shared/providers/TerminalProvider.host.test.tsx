import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { openLocalApiWebSocket } from '@/shared/lib/localApiTransport';
import { useTerminal } from '@/shared/hooks/useTerminal';
import { TerminalProvider } from './TerminalProvider';

vi.mock('@/shared/lib/localApiTransport', () => ({
  openLocalApiWebSocket: vi.fn(),
}));

type FakeSocket = {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen?: () => void;
  onclose?: (event: { code: number; wasClean: boolean }) => void;
};
let dom: ReturnType<typeof installDomlessReact>;
let terminal: ReturnType<typeof useTerminal>;
let sockets: FakeSocket[];

function Probe() {
  terminal = useTerminal();
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  dom = installDomlessReact();
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  sockets = [];
  vi.mocked(openLocalApiWebSocket)
    .mockReset()
    .mockImplementation(async () => {
      const socket: FakeSocket = {
        readyState: 1,
        send: vi.fn(),
        close: vi.fn(),
      };
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
  await dom.render(
    <TerminalProvider>
      <Probe />
    </TerminalProvider>
  );
});
afterEach(async () => {
  await dom.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('terminal connection host', () => {
  it.each([['host-b'], [null]])(
    'opens the shell on the tab’s host %s and reconnects to the same one',
    async (hostId) => {
      terminal.createTerminalConnection(
        'tab-1',
        '/api/terminal/ws?cols=80&rows=24',
        hostId,
        () => {}
      );
      await vi.advanceTimersByTimeAsync(0);
      const explicit = { hostScope: 'explicit', hostId, relayHostId: hostId };
      expect(openLocalApiWebSocket).toHaveBeenCalledExactlyOnceWith(
        '/api/terminal/ws?cols=80&rows=24',
        explicit
      );

      // The connection drops; by now another pane may have focus.
      sockets[0].onclose?.({ code: 1006, wasClean: false });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(openLocalApiWebSocket).toHaveBeenCalledTimes(2);
      expect(openLocalApiWebSocket).toHaveBeenLastCalledWith(
        '/api/terminal/ws?cols=80&rows=24',
        explicit
      );
    }
  );
});
