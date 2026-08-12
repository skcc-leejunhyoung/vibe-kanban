import { useContext } from 'react';
import { createStore, useStore } from 'zustand';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type { Diff, DiffStats, UnifiedPrComment } from 'shared/types';
import type { NormalizedGitHubComment } from '@/shared/hooks/useWorkspaceContext';

// ---------------------------------------------------------------------------
// Workspace diff data (diffs, stats, GitHub comments).
// Each WorkspaceProvider owns a store instance and provides it via context so
// several workspace panes can coexist in one document without clobbering each
// other. Consumers subscribe through the exported atomic selectors below.
// ---------------------------------------------------------------------------

const EMPTY_DIFFS: Diff[] = [];
const EMPTY_DIFF_PATHS: Set<string> = new Set();
const EMPTY_DIFF_STATS: DiffStats = {
  files_changed: 0,
  lines_added: 0,
  lines_removed: 0,
};
const EMPTY_COMMENTS: UnifiedPrComment[] = [];
const EMPTY_NORMALIZED: NormalizedGitHubComment[] = [];
const EMPTY_FILES: string[] = [];

const noopGetCommentsForFile = () => EMPTY_NORMALIZED;
const noopGetCommentCountForFile = () => 0;
const noopGetFilesWithComments = () => EMPTY_FILES;
const noopGetFirstCommentLine = () => null;
const noopSetShowGitHubComments = () => {};

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface WorkspaceDiffData {
  diffs: Diff[];
  diffPaths: Set<string>;
  diffStats: DiffStats;
  gitHubComments: UnifiedPrComment[];
  gitHubCommentsRepoId: string | null;
  isGitHubCommentsLoading: boolean;
  showGitHubComments: boolean;
  setShowGitHubComments: (show: boolean) => void;
  getGitHubCommentsForFile: (filePath: string) => NormalizedGitHubComment[];
  getGitHubCommentCountForFile: (filePath: string) => number;
  getFilesWithGitHubComments: () => string[];
  getFirstCommentLineForFile: (filePath: string) => number | null;
}

interface WorkspaceDiffState extends WorkspaceDiffData {
  /** Batch-update all diff data fields. Called by WorkspaceProvider. */
  setWorkspaceDiffData: (data: WorkspaceDiffData) => void;
  /** Reset to defaults. Called on workspace switch / unmount. */
  clearWorkspaceDiffData: () => void;
}

const DEFAULT_DATA: WorkspaceDiffData = {
  diffs: EMPTY_DIFFS,
  diffPaths: EMPTY_DIFF_PATHS,
  diffStats: EMPTY_DIFF_STATS,
  gitHubComments: EMPTY_COMMENTS,
  gitHubCommentsRepoId: null,
  isGitHubCommentsLoading: false,
  showGitHubComments: false,
  setShowGitHubComments: noopSetShowGitHubComments,
  getGitHubCommentsForFile: noopGetCommentsForFile,
  getGitHubCommentCountForFile: noopGetCommentCountForFile,
  getFilesWithGitHubComments: noopGetFilesWithComments,
  getFirstCommentLineForFile: noopGetFirstCommentLine,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createWorkspaceDiffStore() {
  return createStore<WorkspaceDiffState>()((set) => ({
    ...DEFAULT_DATA,

    setWorkspaceDiffData: (data) => set(data),

    clearWorkspaceDiffData: () => set(DEFAULT_DATA),
  }));
}

export type WorkspaceDiffStore = ReturnType<typeof createWorkspaceDiffStore>;

// Trees without a WorkspaceProvider (e.g. the standalone VSCode page) fall
// back to this shared instance, matching the old global-store behaviour.
const defaultWorkspaceDiffStore = createWorkspaceDiffStore();

const WorkspaceDiffStoreContext = createHmrContext<WorkspaceDiffStore>(
  'WorkspaceDiffStoreContext',
  defaultWorkspaceDiffStore
);

export const WorkspaceDiffStoreProvider = WorkspaceDiffStoreContext.Provider;

function useWorkspaceDiffSelector<T>(
  selector: (state: WorkspaceDiffState) => T
): T {
  return useStore(useContext(WorkspaceDiffStoreContext), selector);
}

// ---------------------------------------------------------------------------
// Atomic selectors — each subscribes to a single field to minimise rerenders
// ---------------------------------------------------------------------------

export const useDiffs = () => useWorkspaceDiffSelector((s) => s.diffs);

export const useDiffPaths = () => useWorkspaceDiffSelector((s) => s.diffPaths);

export const useDiffStats = () => useWorkspaceDiffSelector((s) => s.diffStats);

export const useStoreDiffGitHubComments = () =>
  useWorkspaceDiffSelector((s) => s.gitHubComments);

export const useGitHubCommentsRepoId = () =>
  useWorkspaceDiffSelector((s) => s.gitHubCommentsRepoId);

export const useIsGitHubCommentsLoading = () =>
  useWorkspaceDiffSelector((s) => s.isGitHubCommentsLoading);

export const useShowGitHubComments = () =>
  useWorkspaceDiffSelector((s) => s.showGitHubComments);

export const useSetShowGitHubComments = () =>
  useWorkspaceDiffSelector((s) => s.setShowGitHubComments);

export const useGetGitHubCommentsForFile = () =>
  useWorkspaceDiffSelector((s) => s.getGitHubCommentsForFile);

export const useGetGitHubCommentCountForFile = () =>
  useWorkspaceDiffSelector((s) => s.getGitHubCommentCountForFile);

export const useGetFilesWithGitHubComments = () =>
  useWorkspaceDiffSelector((s) => s.getFilesWithGitHubComments);

export const useGetFirstCommentLineForFile = () =>
  useWorkspaceDiffSelector((s) => s.getFirstCommentLineForFile);
