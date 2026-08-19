import type { ActionsContextValue } from '@/shared/hooks/useActions';
import { useWorkspacePanesStore } from '@/shared/stores/useWorkspacePanesStore';

type ExecuteAction = ActionsContextValue['executeAction'];

const executors = new Map<string, ExecuteAction>();

export function registerPaneActionExecutor(
  paneId: string,
  executeAction: ExecuteAction
): () => void {
  executors.set(paneId, executeAction);
  return () => {
    if (executors.get(paneId) === executeAction) executors.delete(paneId);
  };
}

export function getActivePaneActionExecutor(): ExecuteAction | undefined {
  const { activePaneId } = useWorkspacePanesStore.getState();
  return getPaneActionExecutor(activePaneId);
}

export function getPaneActionExecutor(
  paneId: string | null
): ExecuteAction | undefined {
  return paneId ? executors.get(paneId) : undefined;
}
