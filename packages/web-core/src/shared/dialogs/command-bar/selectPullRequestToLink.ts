import { GitPullRequestIcon } from '@phosphor-icons/react';
import type { PullRequestDetail } from 'shared/types';
import { ActionTargetType } from '@/shared/types/actions';
import { SelectionDialog } from './SelectionDialog';

/** Select one not-yet-linked PR discovered for the workspace branch. */
export async function selectPullRequestToLink(
  prs: PullRequestDetail[]
): Promise<PullRequestDetail | undefined> {
  const selectedUrl = (await SelectionDialog.show({
    initialPageId: 'selectPr',
    pages: {
      selectPr: {
        id: 'selectPr',
        title: 'Link Pull Request',
        buildGroups: () => [
          {
            label: 'Available Pull Requests',
            items: prs.map((pr) => ({
              type: 'action' as const,
              action: {
                id: pr.url,
                label: `#${pr.number} ${pr.title}`,
                description: `${pr.head_branch} → ${pr.base_branch} · ${pr.status}`,
                icon: GitPullRequestIcon,
                requiresTarget: ActionTargetType.NONE,
                execute: () => {},
              },
            })),
          },
        ],
        onSelect: (item) => ({
          type: 'complete' as const,
          data: item.type === 'action' ? item.action.id : undefined,
        }),
      },
    },
  })) as string | undefined;

  return prs.find((pr) => pr.url === selectedUrl);
}
