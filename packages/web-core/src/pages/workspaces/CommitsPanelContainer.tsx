import { memo, useMemo } from 'react';
import { GitCommitIcon } from '@phosphor-icons/react';
import { useWorkspaceCommits } from '@/shared/hooks/useWorkspaceCommits';
import {
  useChangesCommitStore,
  useSelectedCommit,
} from '@/shared/stores/useChangesCommitStore';
import { formatRelativeTime } from '@/shared/lib/date';
import { cn } from '@/shared/lib/utils';
import { useHostId } from '@/shared/providers/HostIdProvider';

interface CommitsPanelContainerProps {
  workspaceId: string;
  onOpenCommit: () => void;
}

export const CommitsPanelContainer = memo(function CommitsPanelContainer({
  workspaceId,
  onOpenCommit,
}: CommitsPanelContainerProps) {
  const { data: commits, isLoading } = useWorkspaceCommits(workspaceId);
  const selected = useSelectedCommit(workspaceId);
  const hostId = useHostId();
  const select = useChangesCommitStore((state) => state.select);
  const multiRepo = useMemo(
    () => new Set((commits ?? []).map((commit) => commit.repo_id)).size > 1,
    [commits]
  );

  if (isLoading) {
    return <p className="p-base text-xs text-low">Loading commits…</p>;
  }

  if (!commits?.length) {
    return (
      <p className="p-base text-xs text-low">
        No commits added on this workspace branch.
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col divide-y">
      {commits.map((commit) => {
        const isSelected =
          selected?.repoId === commit.repo_id && selected.sha === commit.sha;

        return (
          <button
            key={`${commit.repo_id}:${commit.sha}`}
            type="button"
            className={cn(
              'flex w-full items-start gap-half px-base py-2 text-left transition-colors hover:bg-primary',
              isSelected && 'bg-primary'
            )}
            onClick={() => {
              select(workspaceId, hostId, {
                repoId: commit.repo_id,
                sha: commit.sha,
              });
              onOpenCommit();
            }}
          >
            <GitCommitIcon className="mt-0.5 size-icon-base shrink-0 text-low" />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-medium text-high">
                {commit.subject || commit.short_sha}
              </span>
              {commit.description && (
                <span className="whitespace-pre-wrap break-words text-xs text-normal">
                  {commit.description}
                </span>
              )}
              <span className="flex flex-wrap items-center gap-1 text-xs text-low">
                <span className="font-mono">{commit.short_sha}</span>
                <span>· {formatRelativeTime(commit.committed_at)}</span>
                {commit.author && <span>· {commit.author}</span>}
                {multiRepo && <span>· {commit.repo_name}</span>}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
});
