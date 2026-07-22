import { create } from 'zustand';
import { useHostId } from '@/shared/providers/HostIdProvider';

// ---------------------------------------------------------------------------
// Tracks which commit (if any) the Changes view is scoped to, per workspace.
// `undefined` / absent means "All changes" — the default live worktree diff.
// Keyed by workspace so switching workspaces naturally restores each one's
// selection without explicit cleanup.
// ---------------------------------------------------------------------------

export interface SelectedCommit {
  repoId: string;
  sha: string;
}

interface ChangesCommitState {
  selectedByWorkspace: Record<string, SelectedCommit | undefined>;
  /** Select a commit to scope the Changes view to, or `null` for All changes. */
  select: (
    workspaceId: string,
    hostId: string | null,
    commit: SelectedCommit | null
  ) => void;
}

export const changesCommitWorkspaceKey = (
  workspaceId: string,
  hostId: string | null
) => `${hostId ?? 'local'}:${workspaceId}`;

export const useChangesCommitStore = create<ChangesCommitState>((set) => ({
  selectedByWorkspace: {},
  select: (workspaceId, hostId, commit) =>
    set((s) => ({
      selectedByWorkspace: {
        ...s.selectedByWorkspace,
        [changesCommitWorkspaceKey(workspaceId, hostId)]: commit ?? undefined,
      },
    })),
}));

/** The commit the Changes view is scoped to for `workspaceId`, or null. */
export const useSelectedCommit = (
  workspaceId: string | null | undefined
): SelectedCommit | null => {
  const hostId = useHostId();
  return useChangesCommitStore((s) =>
    workspaceId
      ? (s.selectedByWorkspace[
          changesCommitWorkspaceKey(workspaceId, hostId)
        ] ?? null)
      : null
  );
};
