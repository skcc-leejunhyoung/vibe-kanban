import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocalApiTransport } from '@/shared/lib/localApiTransport';
import { useAuthMutations } from './useAuthMutations';

describe('local OAuth handoff', () => {
  afterEach(() => setLocalApiTransport(null));

  it.each([true, false])(
    'sends reauthenticate=%s through the actual hook and API',
    async (reauthenticate) => {
      const request = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                handoff_id: 'handoff',
                authorize_url: 'https://vibe.test/oauth',
              },
            })
          )
      );
      setLocalApiTransport({ request, openWebSocket: vi.fn() });
      let auth: ReturnType<typeof useAuthMutations>;
      function Probe() {
        auth = useAuthMutations();
        return null;
      }
      const client = new QueryClient();
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      );
      await auth!.initHandoff.mutateAsync({
        provider: 'github',
        returnTo: 'http://localhost:3000/api/auth/handoff/complete',
        reauthenticate,
      });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]).toMatchObject([
        '/api/auth/handoff/init',
        {
          method: 'POST',
          body: JSON.stringify({
            provider: 'github',
            return_to: 'http://localhost:3000/api/auth/handoff/complete',
            reauthenticate,
          }),
        },
      ]);
      client.clear();
    }
  );

  it.each([true, false])(
    'releases a cancelled handoff (initialization still pending: %s)',
    async (pending) => {
      let resolveInit: (response: Response) => void;
      const initResponse = new Promise<Response>((resolve) => {
        resolveInit = resolve;
      });
      const request = vi.fn(async (path: string) => {
        if (path === '/api/auth/handoff/init') return initResponse;
        return new Response(null, { status: 204 });
      });
      setLocalApiTransport({ request, openWebSocket: vi.fn() });
      const onInitSuccess = vi.fn();
      let auth: ReturnType<typeof useAuthMutations>;
      function Probe() {
        auth = useAuthMutations({ onInitSuccess });
        return null;
      }
      const client = new QueryClient();
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      );
      const init = auth!.initHandoff.mutateAsync({
        provider: 'github',
        returnTo: 'http://localhost/callback',
        reauthenticate: true,
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      if (pending) auth!.cancelHandoff();
      resolveInit!(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              handoff_id: 'cancelled',
              authorize_url: 'https://vibe.test/oauth',
            },
          })
        )
      );
      await init;
      if (!pending) auth!.cancelHandoff();
      auth!.cancelHandoff(); // repeated cleanup is harmless
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]).toMatchObject([
        '/api/auth/handoff/cancel',
        {
          method: 'POST',
          body: JSON.stringify({ handoff_id: 'cancelled' }),
        },
      ]);
      expect(onInitSuccess).toHaveBeenCalledTimes(pending ? 0 : 1);
      client.clear();
    }
  );
});
