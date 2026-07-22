import { beforeEach, describe, expect, it } from 'vitest';
import {
  changesCommitWorkspaceKey,
  useChangesCommitStore,
} from './useChangesCommitStore';

describe('useChangesCommitStore', () => {
  beforeEach(() => {
    useChangesCommitStore.setState({ selectedByWorkspace: {} });
  });

  it('isolates selected commits by host', () => {
    const localCommit = { repoId: 'repo-local', sha: 'local-sha' };
    const remoteCommit = { repoId: 'repo-remote', sha: 'remote-sha' };

    useChangesCommitStore.getState().select('workspace', null, localCommit);
    useChangesCommitStore
      .getState()
      .select('workspace', 'remote-host', remoteCommit);

    const selections = useChangesCommitStore.getState().selectedByWorkspace;
    expect(selections[changesCommitWorkspaceKey('workspace', null)]).toEqual(
      localCommit
    );
    expect(
      selections[changesCommitWorkspaceKey('workspace', 'remote-host')]
    ).toEqual(remoteCommit);
  });
});
