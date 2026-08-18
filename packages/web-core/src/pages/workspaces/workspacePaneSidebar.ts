export function shouldShowWorkspacePaneSidebar({
  isVisible,
  isCreateMode,
}: {
  isVisible: boolean;
  isCreateMode: boolean;
}): boolean {
  return isVisible && !isCreateMode;
}

export function shouldCloseWorkspacePaneSidebarOnEscape({
  isVisible,
  isPaneActive,
  isCompact,
  rightMainPanelOpen,
}: {
  isVisible: boolean;
  isPaneActive: boolean;
  isCompact: boolean;
  rightMainPanelOpen: boolean;
}): boolean {
  return isVisible && isPaneActive && isCompact && !rightMainPanelOpen;
}
