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
    },
  },
});
