import { useCallback, type MouseEvent } from 'react';
import {
  selectScopedSelectedIssueIds,
  useIssueSelectionStore,
} from '@/shared/stores/useIssueSelectionStore';

/**
 * Split panes share one selection store. Only the board that owns it (the
 * active pane whose project published the selection scope) sees it; other
 * boards render no selection and no bulk bar, so a click never lands on a
 * stale bar wired to another project.
 */
export function useIssueMultiSelect(scopeId: string, isActivePane: boolean) {
  const ownsSelection = useIssueSelectionStore(
    (s) => isActivePane && s.selectionScopeId === scopeId
  );
  const selectedIssueIds = useIssueSelectionStore(
    selectScopedSelectedIssueIds(isActivePane ? scopeId : null)
  );
  const storeIsSelectionMode = useIssueSelectionStore((s) => s.isSelectionMode);
  const isSelectionMode = ownsSelection && storeIsSelectionMode;
  const enterSelectionMode = useIssueSelectionStore(
    (s) => s.enterSelectionMode
  );
  const toggleIssue = useIssueSelectionStore((s) => s.toggleIssue);
  const selectRange = useIssueSelectionStore((s) => s.selectRange);
  const clearSelection = useIssueSelectionStore((s) => s.clearSelection);
  const selectAll = useIssueSelectionStore((s) => s.selectAll);

  // Multi-select affordances (checkboxes, bulk bar, drag-disable) are active
  // either when the user has explicitly entered selection mode (touch/mobile)
  // or once more than one issue is selected (desktop Cmd/Shift+Click flow).
  const isMultiSelectActive = isSelectionMode || selectedIssueIds.size > 1;

  const handleIssueClick = useCallback(
    (issueId: string, event: MouseEvent) => {
      const isMetaClick = event.metaKey || event.ctrlKey;
      const isShiftClick = event.shiftKey;

      // In explicit selection mode a plain tap toggles; Shift still ranges
      // when a hardware keyboard is present.
      if (isSelectionMode && !isMetaClick && !isShiftClick) {
        toggleIssue(issueId);
        return;
      }

      if (isMetaClick) {
        // Cmd/Ctrl+Click: toggle this issue in multi-select
        event.preventDefault();
        toggleIssue(issueId);
      } else if (isShiftClick) {
        // Shift+Click: range select from anchor to this issue
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        selectRange(issueId);
      }
    },
    [isSelectionMode, toggleIssue, selectRange]
  );

  const handleCheckboxChange = useCallback(
    (issueId: string, _checked?: boolean) => {
      toggleIssue(issueId);
    },
    [toggleIssue]
  );

  return {
    selectedIssueIds,
    isSelectionMode,
    isMultiSelectActive,
    enterSelectionMode,
    handleIssueClick,
    handleCheckboxChange,
    handleSelectAll: selectAll,
    clearSelection,
  };
}
