import { memo, useEffect, useMemo } from 'react';
import {
  GitCommitIcon,
  GitBranchIcon,
  CaretDownIcon,
  CheckIcon,
} from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@vibe/ui/components/DropdownMenu';
import { useWorkspaceCommits } from '@/shared/hooks/useWorkspaceCommits';
import {
  useSelectedCommit,
  useChangesCommitStore,
} from '@/shared/stores/useChangesCommitStore';
import { formatRelativeTime } from '@/shared/lib/date';
import { useHostId } from '@/shared/providers/HostIdProvider';

interface CommitSelectorProps {
  workspaceId: string;
}

/**
 * Header control for the Changes panel that lets the user scope the diff to a
 * single commit the workspace added, or back to "All changes" (the live
 * worktree diff). Renders nothing when the branch added no commits.
 */
export const CommitSelector = memo(function CommitSelector({
  workspaceId,
}: CommitSelectorProps) {
  const { data: commits } = useWorkspaceCommits(workspaceId);
  const selected = useSelectedCommit(workspaceId);
  const hostId = useHostId();
  const select = useChangesCommitStore((s) => s.select);

  const selectedCommit = useMemo(
    () =>
      selected
        ? (commits?.find(
            (c) => c.sha === selected.sha && c.repo_id === selected.repoId
          ) ?? null)
        : null,
    [commits, selected]
  );

  // If the selected commit disappeared (e.g. it was rebased or squashed away),
  // fall back to All changes so we don't keep requesting a missing diff.
  useEffect(() => {
    if (selected && commits && !selectedCommit) {
      select(workspaceId, hostId, null);
    }
  }, [selected, commits, selectedCommit, select, workspaceId, hostId]);

  const multiRepo = useMemo(
    () => new Set((commits ?? []).map((c) => c.repo_id)).size > 1,
    [commits]
  );

  if (!commits || commits.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-base py-1 border-b bg-secondary shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 min-w-0 max-w-full rounded border bg-primary px-2 py-1 text-xs hover:bg-primary/70 transition-colors"
          >
            {selectedCommit ? (
              <GitCommitIcon className="size-icon-xs shrink-0 text-low" />
            ) : (
              <GitBranchIcon className="size-icon-xs shrink-0 text-low" />
            )}
            <span className="truncate">
              {selectedCommit ? (
                <>
                  <span className="font-mono text-low">
                    {selectedCommit.short_sha}
                  </span>{' '}
                  {selectedCommit.subject || ''}
                </>
              ) : (
                'All changes'
              )}
            </span>
            <CaretDownIcon className="size-icon-xs shrink-0 text-low" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[440px]">
          <DropdownMenuItem
            className="flex items-center gap-2"
            onSelect={() => select(workspaceId, hostId, null)}
          >
            <GitBranchIcon className="size-icon-base shrink-0 text-low" />
            <span className="flex-1">All changes</span>
            {!selected && <CheckIcon className="size-icon-xs shrink-0" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {commits.map((c) => {
            const isActive =
              selected?.sha === c.sha && selected?.repoId === c.repo_id;
            return (
              <DropdownMenuItem
                key={`${c.repo_id}:${c.sha}`}
                className="flex items-start gap-2"
                onSelect={() =>
                  select(workspaceId, hostId, {
                    repoId: c.repo_id,
                    sha: c.sha,
                  })
                }
              >
                <GitCommitIcon className="size-icon-base shrink-0 text-low mt-0.5" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{c.subject || c.short_sha}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-low truncate">
                    <span className="font-mono">{c.short_sha}</span>
                    <span>· {formatRelativeTime(c.committed_at)}</span>
                    {multiRepo && (
                      <span className="truncate">· {c.repo_name}</span>
                    )}
                  </span>
                </div>
                {isActive && (
                  <CheckIcon className="size-icon-xs shrink-0 mt-0.5" />
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
