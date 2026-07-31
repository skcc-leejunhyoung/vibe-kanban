import type { Diff } from 'shared/types';
import type { DiffViewMode } from '@/shared/stores/useDiffViewStore';

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

export function findDiffByPath(diffs: Diff[], path: string): Diff | null {
  return diffs.find((diff) => getDiffPath(diff) === path) ?? null;
}

export function getDiffStyle(mode: DiffViewMode): 'unified' | 'split' {
  return mode;
}

export function shouldDeferDiffLoad(diff: Diff): boolean {
  if (diff.contentOmitted) return false;
  return (diff.additions ?? 0) + (diff.deletions ?? 0) > DEFER_DIFF_LOAD_LINES;
}
