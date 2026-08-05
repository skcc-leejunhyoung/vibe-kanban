import { create } from 'zustand';

/**
 * Tracks the notification row that currently has (or last had) focus on the
 * notifications page, plus a handler bound to open it in a new tab. The command
 * bar has no per-notification target context, so the "Open Notification in New
 * Tab" action reads this store to act on the focused notification — mirroring a
 * cmd/ctrl+click on that same row.
 */
interface NotificationCursorState {
  /** Id of the focused notification group, or null when none is focused. */
  focusedGroupId: string | null;
  /**
   * Opens the focused notification in a new tab / split pane. Registered by the
   * NotificationsPage while mounted so the palette action reuses the exact
   * cmd+click behavior (mark-seen, remote host pick, deeplink resolution).
   */
  openFocusedInNewTab: (() => void) | null;
  setFocusedGroupId: (id: string | null) => void;
  registerOpenFocusedInNewTab: (fn: (() => void) | null) => void;
}

export const useNotificationCursorStore = create<NotificationCursorState>(
  (set) => ({
    focusedGroupId: null,
    openFocusedInNewTab: null,
    setFocusedGroupId: (id) => set({ focusedGroupId: id }),
    registerOpenFocusedInNewTab: (fn) => set({ openFocusedInNewTab: fn }),
  })
);
