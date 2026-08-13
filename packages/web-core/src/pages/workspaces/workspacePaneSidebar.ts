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
