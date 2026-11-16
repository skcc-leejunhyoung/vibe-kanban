export type HostRequestScope =
  | { kind: 'current' }
  | { kind: 'local' }
  | { kind: 'host'; hostId: string };

export function resolveHostRequestScope(
  hostId?: string | null
): HostRequestScope {
  if (hostId === undefined) {
    return { kind: 'current' };
  }

  if (hostId === null) {
    return { kind: 'local' };
  }

  return { kind: 'host', hostId };
}

export function getHostRequestScopeQueryKey(hostId?: string | null): string {
  const scope = resolveHostRequestScope(hostId);

  switch (scope.kind) {
    case 'current':
      return 'current';
    case 'local':
      return 'local';
    case 'host':
      return scope.hostId;
  }
}

/**
 * The one React Query entry holding a host's config and executor profiles.
 * Every surface showing that host (route shell, pane, settings, quick chat)
 * reads and writes this key, so a save in one is what the others display.
 * `null` is this machine on the local web; the remote web has no such host.
 */
export function getHostUserSystemQueryKey(
  runtime: 'local' | 'remote',
  hostId: string | null
) {
  if (hostId !== null) return ['user-system', 'host', hostId] as const;
  return ['user-system', runtime === 'local' ? 'local' : 'none'] as const;
}

export function shouldOverrideLocalUserSystem(
  hostId: string | null
): hostId is string {
  return hostId !== null;
}
