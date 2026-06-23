import { create } from 'zustand';

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
  select: (workspaceId: string, commit: SelectedCommit | null) => void;
}

export const useChangesCommitStore = create<ChangesCommitState>((set) => ({
  selectedByWorkspace: {},
  select: (workspaceId, commit) =>
    set((s) => ({
      selectedByWorkspace: {
        ...s.selectedByWorkspace,
        [workspaceId]: commit ?? undefined,
      },
    })),
}));

/** The commit the Changes view is scoped to for `workspaceId`, or null. */
export const useSelectedCommit = (
  workspaceId: string | null | undefined
): SelectedCommit | null =>
  useChangesCommitStore((s) =>
    workspaceId ? (s.selectedByWorkspace[workspaceId] ?? null) : null
  );
