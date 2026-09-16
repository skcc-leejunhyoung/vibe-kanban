import { describe, expect, it } from 'vitest';
import type { RepoBranchStatus } from 'shared/types';
import { branchTipSignature } from './workspaceGitRefetch';

const repo = (
  repo_id: string,
  head_oid: string | null,
  commits_ahead: number | null
): RepoBranchStatus =>
  ({ repo_id, head_oid, commits_ahead }) as unknown as RepoBranchStatus;

describe('branchTipSignature', () => {
  it('is empty until branch status has loaded', () => {
    expect(branchTipSignature(undefined)).toBe('');
  });

  it('changes when a commit moves the tip', () => {
    expect(branchTipSignature([repo('r1', 'aaa', 1)])).not.toBe(
      branchTipSignature([repo('r1', 'bbb', 2)])
    );
  });

  it('changes when a merge or target switch moves the base', () => {
    // Merging the work branch into its target leaves HEAD alone but drops the
    // ahead-of-base count, which is what the commit list renders.
    expect(branchTipSignature([repo('r1', 'aaa', 3)])).not.toBe(
      branchTipSignature([repo('r1', 'aaa', 0)])
    );
  });

  it('ignores everything else branch status reports', () => {
    const before = [
      { ...repo('r1', 'aaa', 1), has_uncommitted_changes: true },
    ] as RepoBranchStatus[];
    const after = [
      { ...repo('r1', 'aaa', 1), has_uncommitted_changes: false },
    ] as RepoBranchStatus[];
    expect(branchTipSignature(after)).toBe(branchTipSignature(before));
  });

  it('separates repos so one repo cannot mask another', () => {
    expect(
      branchTipSignature([repo('r1', 'aaa', 1), repo('r2', null, null)])
    ).not.toBe(
      branchTipSignature([repo('r1', 'aaa', 1), repo('r2', 'ccc', 1)])
    );
  });
});
