export const COMMAND_PALETTE_EVENT = {
  toggleWorkspaceArchive: 'command-palette:toggle-workspace-archive',
  focusWorkspaceSearch: 'command-palette:focus-workspace-search',
  focusIssueSearch: 'command-palette:focus-issue-search',
} as const;

export function dispatchCommandPaletteEvent(
  event: (typeof COMMAND_PALETTE_EVENT)[keyof typeof COMMAND_PALETTE_EVENT]
) {
  window.dispatchEvent(new Event(event));
}
