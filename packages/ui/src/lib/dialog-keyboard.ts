import { useEffect } from 'react';

/**
 * Marks a button as the dialog's primary (confirm) action for the
 * Cmd/Ctrl+Enter shortcut when it can't be a `type="submit"` button.
 */
export const DIALOG_PRIMARY_ACTION_ATTR = 'data-dialog-primary';

/**
 * Set on a native Escape keydown when a lower Radix dialog suppressed its own
 * close because another dialog sits above it in the modal stack. Radix only
 * honors `preventDefault()`, which would otherwise also stop the top dialog's
 * document listener from acting on the same keypress — this flag lets the top
 * dialog still claim the key.
 */
export const ESCAPE_DEFERRED_FLAG = '__vibeDialogEscapeDeferred';

export function markEscapeDeferred(event: KeyboardEvent) {
  (event as KeyboardEvent & Record<string, unknown>)[ESCAPE_DEFERRED_FLAG] =
    true;
}

function isEscapeDeferred(event: KeyboardEvent): boolean {
  return Boolean(
    (event as KeyboardEvent & Record<string, unknown>)[ESCAPE_DEFERRED_FLAG]
  );
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter(
    // offsetParent is null inside display:none subtrees; keep the active
    // element so the cycle stays anchored even mid-transition.
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * Resolves the button that confirm shortcuts should activate. Deliberately
 * structural — no text matching, which broke on non-English labels:
 * 1. explicit `data-dialog-primary` marker
 * 2. explicit `type="submit"` attribute
 * 3. the dialog's only button that did not opt out via `type="button"`
 *    (single-action dialogs)
 */
export function findDialogPrimaryAction(
  container: HTMLElement
): HTMLButtonElement | null {
  const marked = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      `button[${DIALOG_PRIMARY_ACTION_ATTR}]`
    )
  ).find((btn) => !btn.disabled);
  if (marked) return marked;

  const submit = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')
  ).find((btn) => !btn.disabled);
  if (submit) return submit;

  const candidates = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button')
  ).filter((btn) => !btn.disabled && btn.getAttribute('type') !== 'button');
  return candidates.length === 1 ? candidates[0] : null;
}

/** Cmd+Enter (mac) / Ctrl+Enter — the dialog "confirm" gesture. */
export function isDialogConfirmKey(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.repeat &&
    !event.isComposing
  );
}

interface DialogKeyboardOptions {
  open: boolean;
  /** Ref accessor for the dialog container element. Must be stable. */
  getContainer: () => HTMLElement | null;
  /** Top-of-stack check from useModalKeyboardLayer. */
  isTopLayer: () => boolean;
  /** Close/cancel handler for Escape. Pass null to disable (uncloseable). */
  onClose?: (() => void) | null;
}

/**
 * Shared keyboard behavior for non-Radix dialog shells (KeyboardDialog,
 * GuideDialogShell). Radix-based dialogs get Escape + focus trapping from
 * Radix itself and only reuse `findDialogPrimaryAction` for confirm.
 *
 * All listeners are native document listeners (bubble phase) rather than
 * `useHotkeys`, so they still fire while an input/textarea/contentEditable
 * is focused. Inner dismissable layers (Radix popovers/selects/dropdowns)
 * `preventDefault()` when they claim a key, and the open-dialog stack gate
 * keeps the shortcuts on the top-most dialog only.
 */
export function useDialogKeyboard({
  open,
  getContainer,
  isTopLayer,
  onClose,
}: DialogKeyboardOptions) {
  // Escape — close/cancel, peeling stacked dialogs inner-first.
  useEffect(() => {
    if (!open || !onClose) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape during IME composition only cancels the composition.
      if (event.isComposing) return;
      if (event.defaultPrevented && !isEscapeDeferred(event)) return;
      if (!isTopLayer()) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose, isTopLayer]);

  // Cmd/Ctrl+Enter — activate the primary action from anywhere in the
  // dialog, including textareas and rich-text editors.
  useEffect(() => {
    if (!open) return;
    const handleConfirm = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isDialogConfirmKey(event)) return;
      if (!isTopLayer()) return;
      const container = getContainer();
      if (!container) return;
      const primary = findDialogPrimaryAction(container);
      if (!primary) return;
      event.preventDefault();
      primary.click();
    };
    document.addEventListener('keydown', handleConfirm);
    return () => document.removeEventListener('keydown', handleConfirm);
  }, [open, getContainer, isTopLayer]);

  // Tab — trap focus inside the dialog so keyboard navigation can't wander
  // into the inert background.
  useEffect(() => {
    if (!open) return;
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      if (!isTopLayer()) return;
      const container = getContainer();
      if (!container) return;

      const active = document.activeElement as HTMLElement | null;
      const inDialog = !!active && container.contains(active);
      // Focus sits in another layer (a portaled popover/select opened from
      // the dialog) — let that layer manage Tab itself.
      if (!inDialog && active && active !== document.body) return;

      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      if (!inDialog) {
        event.preventDefault();
        (event.shiftKey
          ? focusables[focusables.length - 1]
          : focusables[0]
        ).focus();
        return;
      }
      const index = active ? focusables.indexOf(active) : -1;
      if (event.shiftKey) {
        // index -1 covers the container itself (focused on open).
        if (index <= 0) {
          event.preventDefault();
          focusables[focusables.length - 1].focus();
        }
      } else if (index === focusables.length - 1) {
        event.preventDefault();
        focusables[0].focus();
      }
    };
    document.addEventListener('keydown', handleTab);
    return () => document.removeEventListener('keydown', handleTab);
  }, [open, getContainer, isTopLayer]);
}
