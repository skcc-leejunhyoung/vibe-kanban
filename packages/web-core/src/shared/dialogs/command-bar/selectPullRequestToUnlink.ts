import { GitPullRequestIcon } from '@phosphor-icons/react';
import { ActionTargetType } from '@/shared/types/actions';
import { SelectionDialog } from './SelectionDialog';

/** A PR linked to a repo, as needed to pick one to unlink. */
export interface UnlinkablePr {
  /** Unique PR URL — the identity used to unlink the specific PR. */
  url: string;
  number: number;
  status: 'open' | 'merged' | 'closed' | 'unknown';
  headBranch: string;
  baseBranch: string;
}

/**
 * Prompt the user to pick which PR to unlink when a repo tracks more than one.
 * Each PR is presented as a command-bar item; the resolved value is the chosen
 * PR's URL, or `undefined` if the dialog was dismissed.
 */
export async function selectPullRequestToUnlink(
  prs: UnlinkablePr[]
): Promise<string | undefined> {
  return (await SelectionDialog.show({
    initialPageId: 'selectPr',
    pages: {
      selectPr: {
        id: 'selectPr',
        title: 'Unlink Pull Request',
        buildGroups: () => [
          {
            label: 'Pull Requests',
            items: prs.map((pr) => ({
              type: 'action' as const,
              action: {
                // The URL is the unlink identity, so key the item by it.
                id: pr.url,
                label: `PR #${pr.number}`,
                description: `${pr.headBranch} → ${pr.baseBranch} · ${pr.status}`,
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
}
