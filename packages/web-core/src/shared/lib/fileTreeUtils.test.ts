import { describe, expect, it } from 'vitest';
import type { Diff } from 'shared/types';
import {
  buildFileTreeByRepo,
  findDiffByFileTreePath,
  getFileTreePath,
} from './fileTreeUtils';

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

describe('repository-aware file tree', () => {
  it('keeps identical paths in separate repository roots', () => {
    const frontend = makeDiff('repo-1', 'src/index.ts');
    const backend = makeDiff('repo-2', 'src/index.ts');
    const { nodes, groupByRepo } = buildFileTreeByRepo(
      [frontend, backend],
      [
        { id: 'repo-1', label: 'Frontend' },
        { id: 'repo-2', label: 'Backend' },
      ]
    );

    expect(groupByRepo).toBe(true);
    expect(nodes.map((node) => node.name)).toEqual(['Backend', 'Frontend']);
    expect(findDiffByFileTreePath(nodes, getFileTreePath(frontend, true))).toBe(
      frontend
    );
    expect(findDiffByFileTreePath(nodes, getFileTreePath(backend, true))).toBe(
      backend
    );
  });

  it('uses repository-aware active paths for duplicate file names', () => {
    const first = makeDiff('repo-1', 'package.json');
    const second = makeDiff('repo-2', 'package.json');

    expect(getFileTreePath(first, true)).not.toBe(
      getFileTreePath(second, true)
    );
  });

  it('keeps the existing hierarchy when only one repository has changes', () => {
    const diff = makeDiff('repo-1', 'src/index.ts');
    const { nodes, groupByRepo } = buildFileTreeByRepo(
      [diff],
      [{ id: 'repo-1', label: 'Frontend' }]
    );

    expect(groupByRepo).toBe(false);
    expect(nodes[0]?.name).toBe('src');
    expect(findDiffByFileTreePath(nodes, 'src/index.ts')).toBe(diff);
  });

  it('shows the repository root in a multi-repository workspace with one changed repo', () => {
    const diff = makeDiff('repo-1', 'src/index.ts');
    const { nodes, groupByRepo } = buildFileTreeByRepo(
      [diff],
      [
        { id: 'repo-1', label: 'Frontend' },
        { id: 'repo-2', label: 'Backend' },
      ]
    );

    expect(groupByRepo).toBe(true);
    expect(nodes[0]?.name).toBe('Frontend');
  });
});
