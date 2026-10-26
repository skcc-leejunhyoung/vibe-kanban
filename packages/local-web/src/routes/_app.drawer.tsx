import { createFileRoute } from '@tanstack/react-router';
import { DrawerPage } from '@/pages/drawer/DrawerPage';

export const Route = createFileRoute('/_app/drawer')({
  validateSearch: (search: Record<string, unknown>) => ({
    note: typeof search.note === 'string' ? search.note : undefined,
  }),
  component: DrawerRoute,
});

function DrawerRoute() {
  const { note } = Route.useSearch();
  return <DrawerPage initialNoteId={note} />;
}
