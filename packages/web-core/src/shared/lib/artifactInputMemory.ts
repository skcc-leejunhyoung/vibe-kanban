import type { QueryClient } from '@tanstack/react-query';
import type {
  ArtifactInteraction,
  ArtifactResponse,
  ArtifactAutomationRequest,
} from 'shared/types';

export const artifactDrafts = new Map<
  string,
  { draft?: unknown; pending?: ArtifactResponse }
>();
export const artifactPendingRequests = new Map<
  string,
  ArtifactAutomationRequest
>();
export const ARTIFACT_SCOPE_ENDED = 'vibe:artifact:scope-ended';
export type ArtifactMemoryScope = {
  hostId: string | null;
  workspaceId?: string;
  sessionId?: string;
  deleted?: boolean;
};

export function artifactMemoryKey(
  input: ArtifactInteraction,
  hostId: string | null
) {
  return JSON.stringify([
    hostId,
    input.workspace_id,
    input.reference.session_id,
    input.owner_id,
    input.reference.request_id,
  ]);
}

function matches(key: readonly unknown[], scope: ArtifactMemoryScope) {
  return (
    key[0] === scope.hostId &&
    (!scope.workspaceId || key[1] === scope.workspaceId) &&
    (!scope.sessionId || key[2] === scope.sessionId)
  );
}

function artifactQueryMatches(
  query: { queryKey: readonly unknown[] },
  scope: ArtifactMemoryScope
) {
  return (
    [
      'artifact-content',
      'artifact-interactions',
      'artifact-automation',
      'execution-artifacts',
    ].includes(String(query.queryKey[0])) &&
    matches(query.queryKey.slice(1), scope)
  );
}

export function hasArtifactScopeData(
  client: QueryClient,
  scope: ArtifactMemoryScope
) {
  return (
    [...artifactDrafts.keys(), ...artifactPendingRequests.keys()].some((key) =>
      matches(JSON.parse(key), scope)
    ) ||
    client
      .getQueryCache()
      .getAll()
      .some((query) => artifactQueryMatches(query, scope))
  );
}

export function releaseArtifactDocument(
  client: QueryClient,
  scope: ArtifactMemoryScope,
  requestId: string
) {
  client.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === 'artifact-content' &&
      artifactQueryMatches(query, scope) &&
      query.queryKey[8] === requestId &&
      query.getObserversCount() === 0,
  });
}

export function endArtifactScope(scope: ArtifactMemoryScope) {
  for (const map of [artifactDrafts, artifactPendingRequests]) {
    for (const key of map.keys())
      if (matches(JSON.parse(key), scope)) map.delete(key);
  }
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent(ARTIFACT_SCOPE_ENDED, { detail: scope })
    );
}

export async function clearArtifactQueries(
  client: QueryClient,
  scope: ArtifactMemoryScope
) {
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    artifactQueryMatches(query, scope);
  await client.cancelQueries({
    predicate: (query) =>
      predicate(query) &&
      !(
        query.queryKey[0] === 'artifact-content' &&
        query.getObserversCount() > 0
      ),
  });
  for (const query of client.getQueryCache().findAll({ predicate })) {
    // Keep the visible frozen document; its read-only frame releases it on unmount.
    if (
      !scope.deleted &&
      query.queryKey[0] === 'artifact-content' &&
      query.getObserversCount() > 0
    )
      continue;
    if (!scope.deleted && query.queryKey[0] === 'artifact-interactions') {
      client.setQueryData<ArtifactInteraction[]>(query.queryKey, (current) =>
        current?.map((input) =>
          input.state === 'input_required'
            ? { ...input, state: 'expired' }
            : input
        )
      );
    } else client.removeQueries({ queryKey: query.queryKey, exact: true });
  }
}
