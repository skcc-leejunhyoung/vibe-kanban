import type { Diff } from 'shared/types';
import type { DiffViewMode } from '@/shared/stores/useDiffViewStore';
import type { ReviewComment } from '@/shared/hooks/useReview';
import type { DiffSide } from '@/shared/types/diff';

export interface ChangesRepo {
  id: string;
  label: string;
}

export interface DiffGroup {
  repoId: string | null;
  label: string;
  diffs: Diff[];
}

export const DEFER_DIFF_LOAD_LINES = 800;

export function shouldStackChangesPanel(
  width: number,
  height: number
): boolean {
  return height > width;
}

export function getDiffPath(diff: Diff): string {
  return diff.newPath || diff.oldPath || '';
}

export function getDiffKey(diff: Diff): string {
  return `${diff.repoId ?? 'unknown'}:${getDiffPath(diff)}`;
}

export function splitFilePath(path: string): {
  directory: string;
  fileName: string;
} {
  const parts = path.split('/');
  return {
    fileName: parts.pop() || path,
    directory: parts.join('/'),
  };
}

export function groupDiffsByRepo(
  diffs: Diff[],
  repos: ChangesRepo[]
): DiffGroup[] {
  const labelsById = new Map(repos.map((repo) => [repo.id, repo.label]));
  const groups = new Map<string, DiffGroup>();

  for (const diff of diffs) {
    const groupKey = diff.repoId ?? 'unknown';
    const existing = groups.get(groupKey);
    if (existing) {
      existing.diffs.push(diff);
      continue;
    }

    groups.set(groupKey, {
      repoId: diff.repoId,
      label: diff.repoId
        ? (labelsById.get(diff.repoId) ?? diff.repoId)
        : 'Repository',
      diffs: [diff],
    });
  }

  return [...groups.values()];
}

export function findDiffByPath(
  diffs: Diff[],
  path: string,
  repoId?: string | null
): Diff | null {
  return (
    diffs.find(
      (diff) =>
        getDiffPath(diff) === path &&
        (repoId === undefined || diff.repoId === repoId)
    ) ?? null
  );
}

export function resolveSelectedDiff(
  diffs: Diff[],
  selectedKey: string | null
): Diff | null {
  return (
    diffs.find((diff) => getDiffKey(diff) === selectedKey) ?? diffs[0] ?? null
  );
}

export function getAdjacentDiffKey(
  diffs: Diff[],
  currentKey: string,
  direction: 'previous' | 'next'
): string | null {
  const currentIndex = diffs.findIndex(
    (diff) => getDiffKey(diff) === currentKey
  );
  if (currentIndex === -1) return null;

  const adjacentDiff = diffs[currentIndex + (direction === 'next' ? 1 : -1)];
  return adjacentDiff ? getDiffKey(adjacentDiff) : null;
}

export function getDiffStyle(mode: DiffViewMode): 'unified' | 'split' {
  return mode;
}

export function shouldDeferDiffLoad(diff: Diff): boolean {
  if (diff.contentOmitted) return false;
  return (diff.additions ?? 0) + (diff.deletions ?? 0) > DEFER_DIFF_LOAD_LINES;
}

export function getReviewWidgetKey(
  diff: Diff,
  side: DiffSide,
  lineNumber: number
): string {
  return `${getDiffKey(diff)}:${side}:${lineNumber}`;
}

export function getReviewCommentsForDiff(
  comments: ReviewComment[],
  diff: Diff
): ReviewComment[] {
  const path = getDiffPath(diff);
  return comments.filter(
    (comment) => comment.repoId === diff.repoId && comment.filePath === path
  );
}

export function hasGitHubCommentsForDiff(
  diff: Diff,
  gitHubCommentsRepoId: string | null
): boolean {
  return diff.repoId === gitHubCommentsRepoId;
}
