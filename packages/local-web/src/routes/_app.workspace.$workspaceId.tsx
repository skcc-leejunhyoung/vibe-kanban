import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/workspace/$workspaceId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/workspaces/$workspaceId',
      params: { workspaceId: params.workspaceId },
      replace: true,
    });
  },
});
