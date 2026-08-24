import { PrDetailsContent } from '@/shared/dialogs/tasks/PrDetailsDialog';
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  StackIcon,
} from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { cn } from '@/shared/lib/utils';

interface PullRequestDetailsPanelProps {
  prUrl: string;
  prNumber: number;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onGoToMappedIssue: () => void;
  onViewMappedWorkspaces: () => void;
  hasMappedIssue: boolean;
  hasMappedWorkspace: boolean;
}

export function PullRequestDetailsPanel({
  prUrl,
  prNumber,
  onClose,
  onPrevious,
  onNext,
  hasPrevious,
  hasNext,
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
        headerActions={
          onPrevious && onNext ? (
            <>
              <button
                type="button"
                onClick={onPrevious}
                disabled={!hasPrevious}
                className="rounded p-half text-low hover:bg-panel hover:text-high disabled:opacity-30"
                aria-label="Previous pull request"
                title="Previous pull request (Cmd/Ctrl+←)"
              >
                <CaretLeftIcon className="size-icon-sm" weight="bold" />
              </button>
              <button
                type="button"
                onClick={onNext}
                disabled={!hasNext}
                className="rounded p-half text-low hover:bg-panel hover:text-high disabled:opacity-30"
                aria-label="Next pull request"
                title="Next pull request (Cmd/Ctrl+→)"
              >
                <CaretRightIcon className="size-icon-sm" weight="bold" />
              </button>
            </>
          ) : undefined
        }
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
