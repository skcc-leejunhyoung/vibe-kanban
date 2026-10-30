import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactInteraction } from 'shared/types';
import {
  artifactDrafts,
  artifactPendingRequests,
  artifactMemoryKey,
  clearArtifactQueries,
  endArtifactScope,
  releaseArtifactDocument,
  hasArtifactScopeData,
} from './artifactInputMemory';

const input = {
  workspace_id: 'synthetic-workspace',
  owner_id: 'synthetic-owner',
  reference: {
    session_id: 'synthetic-session',
    request_id: 'synthetic-request',
  },
} as ArtifactInteraction;
afterEach(() => {
  artifactDrafts.clear();
  artifactPendingRequests.clear();
});

describe('artifact lifecycle memory cleanup', () => {
  it('keeps a visible frozen preview and releases it after the read-only view unmounts', async () => {
    const client = new QueryClient();
    const scope = {
      hostId: null,
      workspaceId: input.workspace_id,
      sessionId: input.reference.session_id,
    };
    const queryKey = [
      'artifact-content',
      null,
      input.workspace_id,
      input.reference.session_id,
      'process',
      'artifact',
      'hash',
      'preview',
      input.reference.request_id,
      'version',
    ];
    client.setQueryData(queryKey, 'frozen document');
    const observer = new QueryObserver(client, { queryKey, enabled: false });
    const unsubscribe = observer.subscribe(() => {});
    expect(hasArtifactScopeData(client, scope)).toBe(true);
    await clearArtifactQueries(client, scope);
    expect(client.getQueryData(queryKey)).toBe('frozen document');
    releaseArtifactDocument(client, scope, input.reference.request_id);
    expect(client.getQueryData(queryKey)).toBe('frozen document');
    unsubscribe();
    releaseArtifactDocument(client, scope, input.reference.request_id);
    expect(hasArtifactScopeData(client, scope)).toBe(false);
    client.clear();
  });
  it('clears drafts and retries for the exact host and scope only', () => {
    const current = artifactMemoryKey(input, 'host-a');
    const otherHost = artifactMemoryKey(input, 'host-b');
    const otherSession = artifactMemoryKey(
      {
        ...input,
        reference: { ...input.reference, session_id: 'other-session' },
      },
      'host-a'
    );
    for (const key of [current, otherHost, otherSession]) {
      artifactDrafts.set(key, { draft: { note: 'synthetic draft' } });
      artifactPendingRequests.set(key, {
        request_id: 'synthetic-operation',
        action: 'refresh',
        data: {},
      });
    }
    endArtifactScope({
      hostId: 'host-a',
      sessionId: input.reference.session_id,
      deleted: true,
    });
    expect([...artifactDrafts.keys()]).toEqual([otherHost, otherSession]);
    expect([...artifactPendingRequests.keys()]).toEqual([
      otherHost,
      otherSession,
    ]);
    endArtifactScope({ hostId: 'host-a', workspaceId: input.workspace_id });
    expect([...artifactDrafts.keys()]).toEqual([otherHost]);
  });

  it('drops document/data caches and expires inputs without falsifying completed work', async () => {
    const client = new QueryClient();
    const base = ['host-a', input.workspace_id, input.reference.session_id];
    client.setQueryData(['artifact-content', ...base], 'synthetic document');
    client.setQueryData(['artifact-automation', ...base], {
      data: { count: 1 },
    });
    client.setQueryData(
      ['artifact-interactions', ...base],
      [
        { state: 'input_required' },
        { state: 'completed' },
        { state: 'processing' },
      ]
    );
    client.setQueryData(
      ['artifact-content', 'host-b', ...base.slice(1)],
      'other host'
    );
    await clearArtifactQueries(client, {
      hostId: 'host-a',
      workspaceId: input.workspace_id,
    });
    expect(client.getQueryData(['artifact-content', ...base])).toBeUndefined();
    expect(
      client.getQueryData(['artifact-automation', ...base])
    ).toBeUndefined();
    expect(client.getQueryData(['artifact-interactions', ...base])).toEqual([
      { state: 'expired' },
      { state: 'completed' },
      { state: 'processing' },
    ]);
    expect(
      client.getQueryData(['artifact-content', 'host-b', ...base.slice(1)])
    ).toBe('other host');
    await clearArtifactQueries(client, {
      hostId: 'host-a',
      sessionId: input.reference.session_id,
      deleted: true,
    });
    expect(
      client.getQueryData(['artifact-interactions', ...base])
    ).toBeUndefined();
    client.clear();
  });

  it('cancels reads before removal so a late response cannot repopulate the cache', async () => {
    const client = new QueryClient();
    const queryKey = [
      'artifact-content',
      null,
      input.workspace_id,
      input.reference.session_id,
    ];
    let release: (value: string) => void;
    const pending = client
      .fetchQuery({
        queryKey,
        queryFn: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      })
      .catch(() => undefined);
    await clearArtifactQueries(client, {
      hostId: null,
      workspaceId: input.workspace_id,
      deleted: true,
    });
    release!('late synthetic document');
    await pending;
    expect(client.getQueryData(queryKey)).toBeUndefined();
    client.clear();
  });
});
