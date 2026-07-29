import { createFileRoute } from '@tanstack/react-router';
import { PullRequestsPage } from '@/pages/pull-requests/PullRequestsPage';

export const Route = createFileRoute('/_app/pull-requests')({
  component: PullRequestsPage,
});
