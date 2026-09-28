import * as React from 'react';
import { FocusScope } from '@radix-ui/react-focus-scope';

import {
  findDialogPrimaryAction,
  restoreDialogFocus,
  useDialogFocusGuard,
} from '../lib/dialog-keyboard';

interface DialogFocusScopeProps {
  /** Top-of-stack check from useModalKeyboardLayer. */
  isTopLayer: () => boolean;
  /**
   * Focus the button Enter activates on open (an OK-only alert lands on OK);
   * otherwise the container, so keys don't leak into what was focused before.
   */
  focusPrimary?: boolean;
  /**
   * Runs before focus returns to the opener on close; preventDefault() keeps
   * the restore from happening at all, for dialogs that handed focus
   * somewhere deliberate (e.g. a workspace pane they just opened).
   */
  onCloseAutoFocus?: (event: Event) => void;
  /** The dialog panel: a `role="dialog"` element with `tabIndex={-1}`. */
  children: React.ReactElement;
}

/**
 * The focus contract shared by every non-Radix dialog shell:
 * - joins Radix's focus-scope stack, so a Radix modal underneath (the command
 *   bar) is paused instead of pulling focus back to its own input;
 * - on open, focuses the primary action or the container — a dialog that
 *   autofocuses its own field keeps it;
 * - while it is the top modal layer, reclaims focus that lands behind it
 *   (`useDialogFocusGuard`), leaving layers stacked above alone;
 * - on close, returns focus to the opener without select()ing it (Radix's
 *   default would clobber a text draft on the next keystroke), or to the
 *   trigger of the menu the dialog was opened from (see
 *   `keepDialogFocusOnLayerClose`).
 * Mounted only while open: the opener is captured on first render, before the
 * content commits an `autoFocus` that would otherwise hide it.
 */
export function DialogFocusScope({
  isTopLayer,
  focusPrimary = false,
  onCloseAutoFocus,
  children,
}: DialogFocusScopeProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [opener] = React.useState(
    () => document.activeElement as HTMLElement | null
  );
  const getContainer = React.useCallback(() => containerRef.current, []);
  useDialogFocusGuard({ getContainer, isTopLayer });

  const handleMountAutoFocus = React.useCallback(
    (event: Event) => {
      event.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      ((focusPrimary && findDialogPrimaryAction(el)) || el).focus();
    },
    [focusPrimary]
  );

  // Always preventDefault — Radix's fallback would target the same opener, so
  // letting it run would defeat restoreDialogFocus declining.
  const handleUnmountAutoFocus = React.useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event);
      const declined = event.defaultPrevented;
      event.preventDefault();
      // The ref is already null here (Radix restores on a setTimeout after
      // unmount); the event is dispatched on the container itself.
      if (!declined) {
        restoreDialogFocus(opener, event.currentTarget as Element | null);
      }
    },
    [onCloseAutoFocus, opener]
  );

  return (
    <FocusScope
      asChild
      trapped={false}
      ref={containerRef}
      onMountAutoFocus={handleMountAutoFocus}
      onUnmountAutoFocus={handleUnmountAutoFocus}
    >
      {children}
    </FocusScope>
  );
}
