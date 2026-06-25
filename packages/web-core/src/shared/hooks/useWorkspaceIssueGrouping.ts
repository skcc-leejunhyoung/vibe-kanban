import { useEffect, useMemo, useState } from 'react';
import {
  PROJECT_ISSUES_SHAPE,
  PROJECT_PROJECT_STATUSES_SHAPE,
  PROJECT_TAGS_SHAPE,
  PROJECT_ISSUE_TAGS_SHAPE,
  type Issue,
  type IssueTag,
  type Project,
  type ProjectStatus,
  type ShapeDefinition,
  type Tag,
} from 'shared/remote-types';
import { createShapeCollection } from '@/shared/lib/electric/collections';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useUserContext } from '@/shared/hooks/useUserContext';
import { useAllOrganizationProjects } from '@/shared/hooks/useAllOrganizationProjects';
import type { WorkspaceIssueMeta } from '@/shared/lib/workspaceIssueGrouping';

/**
 * Aggregate a project-scoped Electric shape across many projects. Mirrors
 * useAllOrganizationProjects: uses the raw collection API
 * (createShapeCollection + subscribeChanges) instead of calling useShape in a
 * loop, which would violate the rules of hooks. Collections are cached (5-min
 * GC), so projects already synced elsewhere (e.g. the open kanban board) don't
 * re-sync.
 */
function useAggregatedProjectShape<T extends Record<string, unknown>>(
  shape: ShapeDefinition<T>,
  projectIds: string[],
  enabled: boolean
): T[] {
  // Encodes enabled + the sorted project id set into a stable dependency.
  const key = useMemo(
    () => (enabled ? [...projectIds].sort().join(',') : ''),
    [enabled, projectIds]
  );
  const [data, setData] = useState<T[]>([]);

  useEffect(() => {
    if (!key) {
      setData([]);
      return;
    }

    const ids = key.split(',');
    const byProject = new Map<string, T[]>();
    const subscriptions: { unsubscribe: () => void }[] = [];
    const update = () => setData(Array.from(byProject.values()).flat());

    for (const projectId of ids) {
      const collection = createShapeCollection(shape, {
        project_id: projectId,
      });
      if (collection.isReady()) {
        byProject.set(projectId, collection.toArray as unknown as T[]);
      }
      const sub = collection.subscribeChanges(
        () => {
          byProject.set(projectId, collection.toArray as unknown as T[]);
          update();
        },
        { includeInitialState: true }
      );
      subscriptions.push(sub);
    }

    update();
    return () => subscriptions.forEach((s) => s.unsubscribe());
    // `shape` is a module constant; `key` fully captures enabled + projectIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return data;
}

/**
 * Builds a map from local workspace id → issue metadata for the workspace
 * sidebar's issue-grouped view. Workspaces with no linked issue (or whose issue
 * hasn't synced yet) map to `null`, landing them in the unlinked bucket.
 *
 * This relies entirely on remote (Electric) data, so signed-out / purely-local
 * workspaces simply resolve to `null`.
 */
export function useWorkspaceIssueGrouping(
  enabled = true
): Map<string, WorkspaceIssueMeta | null> {
  const { isSignedIn } = useAuth();
  const { workspaces: remoteWorkspaces } = useUserContext();
  const active = enabled && isSignedIn;

  const { data: allProjects } = useAllOrganizationProjects({ enabled: active });

  // Projects that have at least one issue-linked workspace.
  const projectIds = useMemo(() => {
    const set = new Set<string>();
    for (const rw of remoteWorkspaces) {
      if (rw.issue_id && rw.local_workspace_id) set.add(rw.project_id);
    }
    return Array.from(set);
  }, [remoteWorkspaces]);

  const shapesEnabled = active && projectIds.length > 0;

  const issues = useAggregatedProjectShape<Issue>(
    PROJECT_ISSUES_SHAPE,
    projectIds,
    shapesEnabled
  );
  const statuses = useAggregatedProjectShape<ProjectStatus>(
    PROJECT_PROJECT_STATUSES_SHAPE,
    projectIds,
    shapesEnabled
  );
  const tags = useAggregatedProjectShape<Tag>(
    PROJECT_TAGS_SHAPE,
    projectIds,
    shapesEnabled
  );
  const issueTags = useAggregatedProjectShape<IssueTag>(
    PROJECT_ISSUE_TAGS_SHAPE,
    projectIds,
    shapesEnabled
  );

  const issuesById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const statusesById = useMemo(() => {
    const map = new Map<string, ProjectStatus>();
    for (const status of statuses) map.set(status.id, status);
    return map;
  }, [statuses]);

  const tagsById = useMemo(() => {
    const map = new Map<string, Tag>();
    for (const tag of tags) map.set(tag.id, tag);
    return map;
  }, [tags]);

  const tagsByIssueId = useMemo(() => {
    const map = new Map<string, Tag[]>();
    for (const link of issueTags) {
      const tag = tagsById.get(link.tag_id);
      if (!tag) continue;
      const arr = map.get(link.issue_id);
      if (arr) arr.push(tag);
      else map.set(link.issue_id, [tag]);
    }
    return map;
  }, [issueTags, tagsById]);

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of allProjects) map.set(project.id, project);
    return map;
  }, [allProjects]);

  return useMemo(() => {
    const map = new Map<string, WorkspaceIssueMeta | null>();
    if (!active) return map;

    for (const rw of remoteWorkspaces) {
      if (!rw.local_workspace_id) continue;

      const issue = rw.issue_id ? issuesById.get(rw.issue_id) : undefined;
      if (!issue) {
        map.set(rw.local_workspace_id, null);
        continue;
      }

      const project = projectsById.get(issue.project_id);
      const status = statusesById.get(issue.status_id) ?? null;
      const issueTagObjects = tagsByIssueId.get(issue.id) ?? [];

      map.set(rw.local_workspace_id, {
        issueId: issue.id,
        statusName: status?.name ?? null,
        header: {
          displayId: issue.simple_id || `#${issue.issue_number}`,
          title: issue.title,
          projectName: project?.name ?? '',
          projectColor: project?.color ?? null,
          statusName: status?.name ?? null,
          statusColor: status?.color ?? null,
          tags: issueTagObjects.map((tag) => ({
            id: tag.id,
            name: tag.name,
            color: tag.color,
          })),
        },
      });
    }
    return map;
  }, [
    active,
    remoteWorkspaces,
    issuesById,
    statusesById,
    tagsByIssueId,
    projectsById,
  ]);
}
