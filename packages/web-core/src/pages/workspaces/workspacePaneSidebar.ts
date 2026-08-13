export function shouldShowWorkspacePaneSidebar({
  isVisible,
  isPaneActive,
  isCompact,
  isCreateMode,
}: {
  isVisible: boolean;
  isPaneActive: boolean;
  isCompact: boolean;
  isCreateMode: boolean;
}): boolean {
  return isVisible && !isCreateMode && (isPaneActive || !isCompact);
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
