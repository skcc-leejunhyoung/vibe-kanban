import { useEffect } from 'react';
import { isModalKeyboardActive } from '@vibe/ui/lib/modal-keyboard';
import { useIsActivePane } from '@/shared/components/workspace-panes/PaneActiveContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';

export function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      !!target.closest(
        'input, textarea, select, [role="dialog"], [role="menu"], [role="listbox"]'
      ))
  );
}

/** Neighbor of `currentId` in `ids`, or null at either end / when absent. */
export function adjacentIssueId(
  ids: readonly string[],
  currentId: string,
  direction: -1 | 1
): string | null {
  const index = ids.indexOf(currentId);
  if (index < 0) return null;
  return ids[index + direction] ?? null;
}

/**
 * Cmd/Ctrl+Left/Right steps the opened issue through the board order, like
 * the pull request list's detail navigation. Lives at the project layout, not
 * the board: a narrow pane unmounts the board while an issue is open. The
 * order is the one the board last published for this project. Text fields,
 * menus, and keys a focused control already handled are left alone.
 */
export function useOpenedIssueArrowNavigation(
  projectId: string | null | undefined,
  issueId: string | null | undefined
) {
  const isActivePane = useIsActivePane();
  const appNavigation = useAppNavigation();

  useEffect(() => {
    if (!isActivePane || !projectId || !issueId) return;
    const navigate = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isModalKeyboardActive()) return;
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
        isTextEditingTarget(event.target)
      ) {
        return;
      }
      // Prevent even when there is nowhere to go, as the PR list does, so
      // Cmd+Left never falls through to the browser's history Back.
      event.preventDefault();
      const { orderByScope, setAnchor } = useIssueSelectionStore.getState();
      const nextIssueId = adjacentIssueId(
        orderByScope[projectId] ?? [],
        issueId,
        event.key === 'ArrowRight' ? 1 : -1
      );
      if (!nextIssueId) return;
      setAnchor(nextIssueId);
      appNavigation.goToProjectIssue(projectId, nextIssueId, {
        replace: true,
      });
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [isActivePane, projectId, issueId, appNavigation]);
}
