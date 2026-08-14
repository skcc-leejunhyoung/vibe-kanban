import { QueryCache, QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error('[React Query Error]', {
        queryKey: query.queryKey,
        error: error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      // Keep unmounted query data (workspace records, sessions, repos, ...)
      // for 30 minutes instead of the 5-minute default, so revisiting a
      // workspace after a pause renders from cache instead of a spinner.
      gcTime: 1000 * 60 * 30,
      refetchOnWindowFocus: false,
      // Our API is always a loopback (this machine's backend / proxy), so it's
      // reachable regardless of the browser's online verdict. Default
      // 'online' mode pauses fetches once a stray `offline` event flips
      // react-query's onlineManager false — Safari drops the recovering
      // `online` event — leaving queries stuck 'paused' (not loading, not
      // error) and panes blank until a reload.
      networkMode: 'always',
    },
    mutations: {
      networkMode: 'always',
    },
  },
});
