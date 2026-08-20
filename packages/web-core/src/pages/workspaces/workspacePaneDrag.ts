export const workspacePaneDragType = 'application/x-vibe-workspace-pane';

export function isWorkspacePaneDrag(types: readonly string[]) {
  return types.includes(workspacePaneDragType);
}
