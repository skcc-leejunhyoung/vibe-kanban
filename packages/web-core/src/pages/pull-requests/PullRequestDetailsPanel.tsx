import { PrDetailsContent } from '@/shared/dialogs/tasks/PrDetailsDialog';
import { ArrowSquareOutIcon, StackIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { cn } from '@/shared/lib/utils';

interface PullRequestDetailsPanelProps {
  prUrl: string;
  prNumber: number;
  onClose: () => void;
  onGoToMappedIssue: () => void;
  onViewMappedWorkspaces: () => void;
  hasMappedIssue: boolean;
  hasMappedWorkspace: boolean;
}

export function PullRequestDetailsPanel({
  prUrl,
  prNumber,
  onClose,
  onGoToMappedIssue,
  onViewMappedWorkspaces,
  hasMappedIssue,
  hasMappedWorkspace,
}: PullRequestDetailsPanelProps) {
  return (
    <aside className="h-full min-h-0 bg-secondary">
      <PrDetailsContent
        prUrl={prUrl}
        prNumber={prNumber}
        variant="panel"
        onClose={onClose}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={onGoToMappedIssue}
              className={cn(hasMappedIssue && 'bg-brand/10 text-brand')}
              aria-label={`Go to issue mapped to pull request #${prNumber}`}
              title="Go to mapped issue"
            >
              <ArrowSquareOutIcon />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onViewMappedWorkspaces}
              className={cn(hasMappedWorkspace && 'bg-brand/10 text-brand')}
              aria-label={`View workspaces mapped to pull request #${prNumber}`}
              title="View mapped workspaces"
            >
              <StackIcon />
            </Button>
          </>
        }
      />
    </aside>
  );
}
