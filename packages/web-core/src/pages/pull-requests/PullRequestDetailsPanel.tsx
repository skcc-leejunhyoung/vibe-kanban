import { PrDetailsContent } from '@/shared/dialogs/tasks/PrDetailsDialog';

interface PullRequestDetailsPanelProps {
  prUrl: string;
  prNumber: number;
  onClose: () => void;
}

export function PullRequestDetailsPanel({
  prUrl,
  prNumber,
  onClose,
}: PullRequestDetailsPanelProps) {
  return (
    <aside className="h-full min-h-0 bg-secondary">
      <PrDetailsContent
        prUrl={prUrl}
        prNumber={prNumber}
        variant="panel"
        onClose={onClose}
      />
    </aside>
  );
}
