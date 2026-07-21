export function getCycledProjectId(
  projectIds: string[],
  currentProjectId: string | null,
  direction: 1 | -1
): string | null {
  if (projectIds.length === 0) return null;

  const currentIndex = currentProjectId
    ? projectIds.indexOf(currentProjectId)
    : -1;
  if (currentIndex === -1) {
    return direction === 1 ? projectIds[0] : projectIds[projectIds.length - 1];
  }

  return projectIds[
    (currentIndex + direction + projectIds.length) % projectIds.length
  ];
}
