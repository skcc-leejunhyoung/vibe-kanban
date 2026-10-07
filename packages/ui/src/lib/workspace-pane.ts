/**
 * Split panes mark their shell with `data-workspace-pane` and the active one
 * with `data-workspace-pane-active="true"` (web-core WorkspacePaneGrid).
 * Presentational components that claim focus on their own (an issue panel
 * opening, a create form mounting) use this to stay out of panes the user is
 * not working in: a background pane can mount or switch content at any time
 * (data refresh, shared composer state), and pane activation follows DOM
 * focus. Outside the pane grid there is no shell, so focus is never withheld.
 */
export function isInInactiveWorkspacePane(element: Element | null): boolean {
  const pane = element?.closest('[data-workspace-pane]');
  return !!pane && pane.getAttribute('data-workspace-pane-active') !== 'true';
}
