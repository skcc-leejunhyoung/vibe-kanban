import { createFileRoute } from '@tanstack/react-router';
import { HomeTerminalPanel } from '@/shared/components/TerminalPanelContainer';

export const Route = createFileRoute('/_app/terminal')({
  component: HomeTerminalPanel,
});
