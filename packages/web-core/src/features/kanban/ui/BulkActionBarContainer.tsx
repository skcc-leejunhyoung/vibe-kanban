import { useCallback, useMemo } from 'react';
import { useActions } from '@/shared/hooks/useActions';
import { Actions } from '@/shared/actions';
import { BulkActionBar } from '@vibe/ui/components/BulkActionBar';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';

interface BulkActionBarContainerProps {
  projectId: string;
  issueIds: ReadonlySet<string>;
}

export function BulkActionBarContainer({
  projectId,
  issueIds: selectedIssueIds,
}: BulkActionBarContainerProps) {
  const clearSelection = useIssueSelectionStore((s) => s.clearSelection);
  const {
    executeAction,
    openStatusSelection,
    openPrioritySelection,
    openAssigneeSelection,
  } = useActions();

  const issueIds = useMemo(() => [...selectedIssueIds], [selectedIssueIds]);

  const handleChangeStatus = useCallback(async () => {
    await openStatusSelection(projectId, issueIds);
  }, [projectId, issueIds, openStatusSelection]);

  const handleChangePriority = useCallback(async () => {
    await openPrioritySelection(projectId, issueIds);
  }, [projectId, issueIds, openPrioritySelection]);

  const handleChangeAssignees = useCallback(async () => {
    await openAssigneeSelection(projectId, issueIds);
  }, [projectId, issueIds, openAssigneeSelection]);

  // DeleteIssue clears the selection itself once confirmed, so canceling the
  // confirm dialog keeps it.
  const handleDelete = useCallback(async () => {
    await executeAction(Actions.DeleteIssue, undefined, projectId, issueIds);
  }, [executeAction, projectId, issueIds]);

  return (
    <BulkActionBar
      selectedCount={selectedIssueIds.size}
      onChangeStatus={handleChangeStatus}
      onChangePriority={handleChangePriority}
      onChangeAssignees={handleChangeAssignees}
      onDelete={handleDelete}
      onClearSelection={clearSelection}
    />
  );
}
