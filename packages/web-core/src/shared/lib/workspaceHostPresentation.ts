import type { AppBarHost, AppBarHostStatus } from '@vibe/ui/components/AppBar';

export interface WorkspaceHostPresentation {
  name: string;
  status: AppBarHostStatus;
}

export function resolveWorkspaceHostPresentation(
  hostId: string | null,
  hostNickname: string | null | undefined,
  hosts: AppBarHost[],
  thisMachineLabel: string
): WorkspaceHostPresentation {
  if (hostId === null) {
    return {
      name: hostNickname || thisMachineLabel,
      status: 'online',
    };
  }

  const host = hosts.find((candidate) => candidate.id === hostId);
  return {
    name: hostNickname || host?.name || hostId,
    status: host?.status ?? 'unpaired',
  };
}
