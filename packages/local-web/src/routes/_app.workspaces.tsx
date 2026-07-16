import { createFileRoute } from '@tanstack/react-router';
import { WorkspacesListPage } from '@/pages/workspaces/WorkspacesListPage';

export const Route = createFileRoute('/_app/workspaces')({
  component: WorkspacesListPage,
});
