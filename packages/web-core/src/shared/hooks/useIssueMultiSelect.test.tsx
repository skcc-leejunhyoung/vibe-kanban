import { afterEach, beforeEach, expect, it } from 'vitest';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';
import { useIssueMultiSelect } from './useIssueMultiSelect';

let dom: ReturnType<typeof installDomlessReact>;
const seen: Record<string, { size: number; active: boolean }> = {};

function Board({ projectId, active }: { projectId: string; active: boolean }) {
  const { selectedIssueIds, isMultiSelectActive } = useIssueMultiSelect(
    projectId,
    active
  );
  seen[projectId] = {
    size: selectedIssueIds.size,
    active: isMultiSelectActive,
  };
  return null;
}

beforeEach(() => {
  dom = installDomlessReact();
});
afterEach(async () => {
  await dom.unmount();
  useIssueSelectionStore.getState().clearSelection();
});

it('only the owning pane board sees the shared multi-selection', async () => {
  const store = useIssueSelectionStore.getState();
  store.setOrderedIssueIds(['a1', 'a2'], null, 'proj-a');
  store.toggleIssue('a1');
  store.toggleIssue('a2');

  await dom.render(
    <>
      <Board projectId="proj-a" active />
      <Board projectId="proj-b" active={false} />
    </>
  );

  expect(seen['proj-a']).toEqual({ size: 2, active: true });
  expect(seen['proj-b']).toEqual({ size: 0, active: false });
});
