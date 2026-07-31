import { formatDateShortWithTime } from '@/shared/lib/date';

export interface LinkedWorkspaceActivity {
  isArchived?: boolean;
  updatedAt?: string;
  latestProcessStartedAt?: string;
  latestProcessCompletedAt?: string;
}

export function getLinkedWorkspaceDescription(
  workspace: LinkedWorkspaceActivity | undefined,
  fallback: { archived: boolean; updatedAt: string }
): string {
  const activityCandidates = [
    workspace?.latestProcessStartedAt,
    workspace?.latestProcessCompletedAt,
  ].filter((value): value is string => value != null);
  const latestActivity = activityCandidates.reduce<string | undefined>(
    (latest, candidate) => {
      if (!latest) return candidate;
      return new Date(candidate).getTime() > new Date(latest).getTime()
        ? candidate
        : latest;
    },
    undefined
  );
  const timestamp =
    latestActivity ?? workspace?.updatedAt ?? fallback.updatedAt;
  const status =
    (workspace?.isArchived ?? fallback.archived) ? 'Archived' : 'Active';
  return `${status} · ${formatDateShortWithTime(timestamp)}`;
}
