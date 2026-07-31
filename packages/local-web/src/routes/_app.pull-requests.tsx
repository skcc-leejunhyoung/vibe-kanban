import { createFileRoute } from '@tanstack/react-router';
import { PullRequestsPage } from '@/pages/pull-requests/PullRequestsPage';

export const Route = createFileRoute('/_app/pull-requests')({
  validateSearch: (search: Record<string, unknown>) => ({
    prUrl: typeof search.prUrl === 'string' ? search.prUrl : undefined,
  }),
  component: PullRequestsRoute,
});

function PullRequestsRoute() {
  const { prUrl } = Route.useSearch();
  return <PullRequestsPage initialPrUrl={prUrl} />;
}
