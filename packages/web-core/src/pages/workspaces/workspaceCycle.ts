export function getCycledWorkspaceKey(
  displayedWorkspaceKeys: string[],
  selectedWorkspaceKey: string | null,
  direction: 1 | -1
): string | null {
  if (displayedWorkspaceKeys.length === 0) return null;

  const currentIndex = selectedWorkspaceKey
    ? displayedWorkspaceKeys.indexOf(selectedWorkspaceKey)
    : -1;
  if (currentIndex === -1) {
    return direction === 1
      ? displayedWorkspaceKeys[0]
      : displayedWorkspaceKeys[displayedWorkspaceKeys.length - 1];
  }

  const nextIndex =
    (currentIndex + direction + displayedWorkspaceKeys.length) %
    displayedWorkspaceKeys.length;
  return displayedWorkspaceKeys[nextIndex];
}
