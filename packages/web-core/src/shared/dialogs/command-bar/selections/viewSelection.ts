import { KanbanIcon, TableIcon } from '@phosphor-icons/react';
import { ActionTargetType } from '@/shared/types/actions';
import type { ProjectViewSwitcherItem } from '@/shared/stores/useProjectViewSwitcherStore';
import type { SelectionPage } from '../SelectionDialog';

export interface ViewSelectionResult {
  viewId: string;
}

/**
 * Builds a single-page selection listing the project's views. Each view is
 * rendered as a synthetic action item (id = view id, icon by layout); the
 * dialog resolves the chosen view id to the caller.
 */
export function buildViewSelectionPages(
  views: ProjectViewSwitcherItem[],
  activeViewId: string | null
): Record<string, SelectionPage<ViewSelectionResult>> {
  return {
    selectView: {
      id: 'selectView',
      title: 'Select view',
      buildGroups: () => [
        {
          label: 'Views',
          items: views.map((view) => ({
            type: 'action' as const,
            action: {
              id: view.id,
              label: view.name,
              icon: view.layout === 'kanban' ? KanbanIcon : TableIcon,
              requiresTarget: ActionTargetType.NONE,
              isActive: () => view.id === activeViewId,
              execute: () => {},
            },
          })),
        },
      ],
      onSelect: (item) => {
        if (item.type === 'action') {
          return { type: 'complete', data: { viewId: item.action.id } };
        }
        return { type: 'complete', data: undefined as never };
      },
    },
  };
}
