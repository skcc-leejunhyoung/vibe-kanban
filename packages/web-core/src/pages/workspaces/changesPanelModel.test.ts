import { describe, expect, it } from 'vitest';
import type { Diff } from 'shared/types';
import {
  DEFER_DIFF_LOAD_LINES,
  findDiffByPath,
  getDiffKey,
  getDiffStyle,
  getReviewCommentsForDiff,
  getReviewWidgetKey,
  groupDiffsByRepo,
  hasGitHubCommentsForDiff,
  resolveSelectedDiff,
  shouldDeferDiffLoad,
  splitFilePath,
} from './changesPanelModel';
import { DiffSide } from '@/shared/types/diff';

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

describe('changesPanelModel', () => {
  it('keeps identical paths in different repositories independently selectable', () => {
    const first = makeDiff('repo-1', 'package.json');
    const second = makeDiff('repo-2', 'package.json');

    expect(getDiffKey(first)).not.toBe(getDiffKey(second));
  });

  it('groups changed files by repository with display labels', () => {
    const groups = groupDiffsByRepo(
      [
        makeDiff('repo-1', 'src/first.ts'),
        makeDiff('repo-2', 'src/second.ts'),
        makeDiff('repo-1', 'src/third.ts'),
      ],
      [
        { id: 'repo-1', label: 'Frontend' },
        { id: 'repo-2', label: 'Backend' },
      ]
    );

    expect(groups.map(({ label, diffs }) => [label, diffs.length])).toEqual([
      ['Frontend', 2],
      ['Backend', 1],
    ]);
  });

  it('resolves a file requested by the Changes view context', () => {
    const requested = makeDiff('repo-1', 'src/requested.ts');
    expect(
      findDiffByPath(
        [makeDiff('repo-1', 'src/first.ts'), requested],
        'src/requested.ts'
      )
    ).toBe(requested);
  });

  it('resolves identical paths using the requested repository', () => {
    const first = makeDiff('repo-1', 'package.json');
    const second = makeDiff('repo-2', 'package.json');

    expect(findDiffByPath([first, second], 'package.json', 'repo-2')).toBe(
      second
    );
  });

  it('falls back to the first diff for the initial shared selection', () => {
    const first = makeDiff('repo-1', 'src/first.ts');

    expect(resolveSelectedDiff([first], null)).toBe(first);
  });

  it('splits a path so the directory can truncate without hiding the filename', () => {
    expect(splitFilePath('packages/web-core/src/ChangesPanel.tsx')).toEqual({
      directory: 'packages/web-core/src',
      fileName: 'ChangesPanel.tsx',
    });
  });

  it('maps both configured diff layouts to the renderer style', () => {
    expect(getDiffStyle('unified')).toBe('unified');
    expect(getDiffStyle('split')).toBe('split');
  });

  it('defers a large available diff until the user loads it', () => {
    const diff = makeDiff('repo-1', 'src/large.ts');
    diff.additions = DEFER_DIFF_LOAD_LINES + 1;
    diff.deletions = 0;

    expect(shouldDeferDiffLoad(diff)).toBe(true);
  });

  it('does not offer to load content that the backend omitted', () => {
    const diff = makeDiff('repo-1', 'src/omitted.ts');
    diff.contentOmitted = true;
    diff.additions = DEFER_DIFF_LOAD_LINES + 1;

    expect(shouldDeferDiffLoad(diff)).toBe(false);
  });

  it('isolates review comments and draft keys by repository', () => {
    const first = makeDiff('repo-1', 'package.json');
    const second = makeDiff('repo-2', 'package.json');
    const comments = [
      {
        id: 'comment-1',
        repoId: 'repo-1',
        filePath: 'package.json',
        lineNumber: 1,
        side: DiffSide.New,
        text: 'First repository',
      },
      {
        id: 'comment-2',
        repoId: 'repo-2',
        filePath: 'package.json',
        lineNumber: 1,
        side: DiffSide.New,
        text: 'Second repository',
      },
    ];

    expect(getReviewCommentsForDiff(comments, second)).toEqual([comments[1]]);
    expect(getReviewWidgetKey(first, DiffSide.New, 1)).not.toBe(
      getReviewWidgetKey(second, DiffSide.New, 1)
    );
  });

  it('shows GitHub comments only in the repository they were fetched for', () => {
    const first = makeDiff('repo-1', 'package.json');
    const second = makeDiff('repo-2', 'package.json');

    expect(hasGitHubCommentsForDiff(first, 'repo-1')).toBe(true);
    expect(hasGitHubCommentsForDiff(second, 'repo-1')).toBe(false);
  });
});
