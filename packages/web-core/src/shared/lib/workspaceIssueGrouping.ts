import type {
  WorkspaceIssueGroup,
  WorkspaceIssueGroupHeader,
  WorkspaceIssueStatusSection,
  WorkspacesSidebarWorkspace,
} from '@vibe/ui/components/WorkspacesIssueGroupedList';
import { getHostWorkspaceKey } from '@/shared/hooks/useWorkspaces';

/** Sentinel keys for the two special buckets. */
export const UNLINKED_GROUP_KEY = '__unlinked__';
export const UNKNOWN_STATUS_KEY = '__unknown__';

/**
 * Per-workspace issue metadata produced by the data hook. `null` (or a missing
 * entry) means the workspace isn't linked to a (loaded) issue and lands in the
 * unlinked bucket.
 */
export interface WorkspaceIssueMeta {
  issueId: string;
  githubIssues: Array<{
    id: string;
    number: number;
    repository: string;
    url: string;
  }>;
  /** Status name used for status bucketing (matched case-insensitively). */
  statusName: string | null;
  header: WorkspaceIssueGroupHeader;
}

/**
 * Group an ordered list of sidebar workspaces under the issue each is linked
 * to, preserving the incoming workspace order for both groups and rows. Issue
 * groups appear in first-seen order; workspaces with no issue metadata collapse
 * into a single trailing unlinked bucket (header === null).
 */
export function groupWorkspacesByIssue(
  workspaces: WorkspacesSidebarWorkspace[],
  metaByWorkspaceId: Map<string, WorkspaceIssueMeta | null>
): WorkspaceIssueGroup[] {
  const groupMap = new Map<string, WorkspaceIssueGroup>();
  const order: string[] = [];
  const unlinked: WorkspacesSidebarWorkspace[] = [];

  for (const ws of workspaces) {
    const meta =
      metaByWorkspaceId.get(getHostWorkspaceKey(ws.id, ws.hostId ?? null)) ??
      null;
    if (!meta) {
      unlinked.push(ws);
      continue;
    }

    let group = groupMap.get(meta.issueId);
    if (!group) {
      group = { key: meta.issueId, header: meta.header, workspaces: [] };
      groupMap.set(meta.issueId, group);
      order.push(meta.issueId);
    }
    group.workspaces.push(ws);
  }

  const groups = order.map((id) => groupMap.get(id)!);
  if (unlinked.length > 0) {
    groups.push({
      key: UNLINKED_GROUP_KEY,
      header: null,
      workspaces: unlinked,
    });
  }
  return groups;
}

export interface StatusBucketLabels {
  unknown: string;
  unlinked: string;
}

/**
 * Bucket issue groups into status sections. `statusNames` defines both which
 * sections exist and their order; configured sections always render (even when
 * empty) so the layout is stable. Issue groups whose status name doesn't match
 * any configured name fall into a trailing "unknown" section, and the unlinked
 * bucket gets its own trailing section — both shown only when non-empty.
 */
export function bucketIssueGroupsByStatus(
  groups: WorkspaceIssueGroup[],
  statusNames: string[],
  labels: StatusBucketLabels
): WorkspaceIssueStatusSection[] {
  const sectionByName = new Map<string, WorkspaceIssueStatusSection>();
  const sections: WorkspaceIssueStatusSection[] = [];

  statusNames.forEach((rawName, index) => {
    const name = rawName.trim();
    if (!name) return;
    const lower = name.toLowerCase();
    // Skip duplicate names so React keys stay unique and the first wins.
    if (sectionByName.has(lower)) return;
    const section: WorkspaceIssueStatusSection = {
      key: `status-${index}-${lower}`,
      label: name,
      groups: [],
    };
    sectionByName.set(lower, section);
    sections.push(section);
  });

  const unknownSection: WorkspaceIssueStatusSection = {
    key: UNKNOWN_STATUS_KEY,
    label: labels.unknown,
    groups: [],
  };
  const unlinkedSection: WorkspaceIssueStatusSection = {
    key: UNLINKED_GROUP_KEY,
    label: labels.unlinked,
    groups: [],
  };

  for (const group of groups) {
    if (!group.header) {
      unlinkedSection.groups.push(group);
      continue;
    }
    const name = group.header.statusName?.trim().toLowerCase();
    const section = name ? sectionByName.get(name) : undefined;
    (section ?? unknownSection).groups.push(group);
  }

  const result = [...sections];
  if (unknownSection.groups.length > 0) result.push(unknownSection);
  if (unlinkedSection.groups.length > 0) result.push(unlinkedSection);
  return result;
}
