import { StackIcon } from '@phosphor-icons/react';
import { getHostWorkspaceKey } from '@/shared/hooks/useWorkspaces';
import { getLinkedWorkspaceDescription } from '@/shared/lib/linkedWorkspaceDescription';
import { ActionTargetType } from '@/shared/types/actions';
import { SelectionDialog } from './SelectionDialog';

export interface LinkedWorkspace {
  id: string;
  host_id: string | null;
  local_workspace_id: string;
  name: string | null;
  archived: boolean;
  updated_at: string;
}

export interface LinkedWorkspaceSummary {
  id: string;
  hostId?: string | null;
  isArchived?: boolean;
  updatedAt?: string;
  latestProcessStartedAt?: string;
  latestProcessCompletedAt?: string;
}

interface SelectLinkedWorkspaceOptions<TWorkspace extends LinkedWorkspace> {
  title: string;
  workspaces: TWorkspace[];
  workspaceSummaries: LinkedWorkspaceSummary[];
  getDescriptionPrefix?: (workspace: TWorkspace) => string | undefined;
}

export function findLinkedWorkspaceSummary(
  workspace: LinkedWorkspace,
  workspaceSummaries: LinkedWorkspaceSummary[]
): LinkedWorkspaceSummary | undefined {
  return (
    workspaceSummaries.find(
      (candidate) =>
        getHostWorkspaceKey(candidate.id, candidate.hostId ?? null) ===
        getHostWorkspaceKey(workspace.local_workspace_id, workspace.host_id)
    ) ??
    workspaceSummaries.find(
      (candidate) => candidate.id === workspace.local_workspace_id
    )
  );
}

export function buildLinkedWorkspaceSelectionItems<
  TWorkspace extends LinkedWorkspace,
>({
  workspaces,
  workspaceSummaries,
  getDescriptionPrefix,
}: Omit<SelectLinkedWorkspaceOptions<TWorkspace>, 'title'>) {
  return workspaces.map((workspace) => ({
    type: 'action' as const,
    action: {
      id: workspace.id,
      label: workspace.name || 'Untitled workspace',
      description: [
        getDescriptionPrefix?.(workspace),
        getLinkedWorkspaceDescription(
          findLinkedWorkspaceSummary(workspace, workspaceSummaries),
          {
            archived: workspace.archived,
            updatedAt: workspace.updated_at,
          }
        ),
      ]
        .filter(Boolean)
        .join(' · '),
      icon: StackIcon,
      requiresTarget: ActionTargetType.NONE,
      execute: () => {},
    },
  }));
}

export async function selectLinkedWorkspace<
  TWorkspace extends LinkedWorkspace,
>({
  title,
  workspaces,
  workspaceSummaries,
  getDescriptionPrefix,
}: SelectLinkedWorkspaceOptions<TWorkspace>): Promise<TWorkspace | undefined> {
  const selectedId = (await SelectionDialog.show({
    initialPageId: 'linkedWorkspaces',
    pages: {
      linkedWorkspaces: {
        id: 'linkedWorkspaces',
        title,
        buildGroups: () => [
          {
            label: 'Workspaces',
            items: buildLinkedWorkspaceSelectionItems({
              workspaces,
              workspaceSummaries,
              getDescriptionPrefix,
            }),
          },
        ],
        onSelect: (item) => ({
          type: 'complete' as const,
          data: item.type === 'action' ? item.action.id : undefined,
        }),
      },
    },
  })) as string | undefined;

  return workspaces.find((workspace) => workspace.id === selectedId);
}
