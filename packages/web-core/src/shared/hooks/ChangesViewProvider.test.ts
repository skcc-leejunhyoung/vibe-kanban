import { describe, expect, it, vi } from 'vitest';
import type { Diff } from 'shared/types';
import {
  findMatchingChangesTarget,
  notifyChangesFileSelection,
} from './ChangesViewProvider';

function makeDiff(repoId: string, path: string): Diff {
  return {
    change: 'modified',
    oldPath: path,
    newPath: path,
    oldContent: 'old',
    newContent: 'new',
    contentOmitted: false,
    additions: 1,
    deletions: 1,
    repoId,
  };
}

describe('notifyChangesFileSelection', () => {
  it('forwards a Changes view request to the mounted panel', () => {
    const callback = vi.fn();

    notifyChangesFileSelection(callback, 'src/requested.ts', 42);

    expect(callback).toHaveBeenCalledWith('src/requested.ts', 42, undefined);
  });

  it('forwards repeated selection of the same file', () => {
    const callback = vi.fn();

    notifyChangesFileSelection(callback, 'src/repeated.ts');
    notifyChangesFileSelection(callback, 'src/repeated.ts');

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(
      1,
      'src/repeated.ts',
      undefined,
      undefined
    );
    expect(callback).toHaveBeenNthCalledWith(
      2,
      'src/repeated.ts',
      undefined,
      undefined
    );
  });

  it('forwards the repository identity with a file selection', () => {
    const callback = vi.fn();

    notifyChangesFileSelection(callback, 'package.json', undefined, 'repo-2');

    expect(callback).toHaveBeenCalledWith('package.json', undefined, 'repo-2');
  });

  it('allows a request while the Changes panel is not mounted', () => {
    expect(() =>
      notifyChangesFileSelection(null, 'src/requested.ts')
    ).not.toThrow();
  });

  it('does not let the current selection decide an ambiguous path', () => {
    const diffs = [
      makeDiff('repo-1', 'package.json'),
      makeDiff('repo-2', 'package.json'),
    ];

    expect(findMatchingChangesTarget(diffs, 'package.json')).toBeNull();
  });

  it('resolves a repository-qualified path without relying on current selection', () => {
    const diffs = [
      makeDiff('repo-1', 'package.json'),
      makeDiff('repo-2', 'package.json'),
    ];
    const repos = [
      { id: 'repo-1', name: 'frontend' },
      { id: 'repo-2', name: 'backend' },
    ];

    expect(
      findMatchingChangesTarget(diffs, '/workspace/backend/package.json', repos)
    ).toEqual({
      path: 'package.json',
      repoId: 'repo-2',
    });
  });

  it('uses the session working directory to resolve a bare duplicate path', () => {
    const diffs = [
      makeDiff('repo-1', 'package.json'),
      makeDiff('repo-2', 'package.json'),
    ];
    const repos = [
      { id: 'repo-1', name: 'frontend' },
      { id: 'repo-2', name: 'backend' },
    ];

    expect(
      findMatchingChangesTarget(diffs, 'package.json', repos, 'backend')
    ).toEqual({
      path: 'package.json',
      repoId: 'repo-2',
    });
  });

  it('prefers an exact path over a shorter suffix match', () => {
    const diffs = [
      makeDiff('repo-1', 'foo.ts'),
      makeDiff('repo-1', 'src/foo.ts'),
    ];

    expect(findMatchingChangesTarget(diffs, 'src/foo.ts')).toEqual({
      path: 'src/foo.ts',
      repoId: 'repo-1',
    });
  });
});
