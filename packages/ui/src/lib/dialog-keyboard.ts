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

// `tabindex="-1"` is excluded everywhere: those elements are focusable only
// programmatically (roving list items, the dialog shell, react-dropzone's
// visually-hidden file input) and must not appear in the Tab cycle — landing
// on an invisible file input makes the next Enter open a file picker.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]',
]
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(', ');

/**
 * Elements that already activate themselves on Enter. A dialog-level Enter
 * shortcut has to leave the key to them — otherwise keyboard navigation (Tab
 * to a control, press Enter) silently fires the dialog's primary action
 * instead of the control the user is standing on.
 */
const ENTER_ACTIVATES_SELF_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="option"]',
  '[role^="menuitem"]',
].join(', ');

export function activatesOnEnter(el: Element | null): boolean {
  return !!el?.closest(ENTER_ACTIVATES_SELF_SELECTOR);
}

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

/** True while keyboard focus sits inside an open dialog. */
export function isFocusInDialog(): boolean {
  const active = document.activeElement;
  return (
    !!active && active !== document.body && !!active.closest('[role="dialog"]')
  );
}

// Dialog element -> the trigger of the menu/select/popover an item of which
// opened it (recorded by keepDialogFocusOnLayerClose). The item itself is gone
// with the layer, so this is where focus belongs once the dialog closes.
const layerOpeners = new WeakMap<Element, HTMLElement>();

/**
 * Hands focus back to the element that opened a dialog — or, when the dialog
 * was opened from a menu item, to that menu's trigger. Declines when the
 * target is gone, or when focus already sits in another dialog: focus scopes
 * restore on a `setTimeout(0)`, so in an `await ConfirmDialog.show()` chain the
 * next dialog has already mounted and focused itself by then — restoring would
 * yank focus out of it, back behind the modal.
 */
export function restoreDialogFocus(
  opener: HTMLElement | null,
  dialog?: Element | null
): void {
  const target = (dialog && layerOpeners.get(dialog)) ?? opener;
  if (!target?.isConnected || isFocusInDialog()) return;
  target.focus({ preventScroll: true });
}

/** The trigger of a Radix menu/select/popover, from its content element. */
function layerTrigger(content: Element | null): HTMLElement | null {
  if (!content) return null;
  // Menus are labelled by their trigger; selects and popovers point the
  // trigger at the content through aria-controls.
  const labelledBy = content.getAttribute('aria-labelledby');
  if (content.getAttribute('role') === 'menu' && labelledBy) {
    return document.getElementById(labelledBy);
  }
  return content.id
    ? document.querySelector<HTMLElement>(
        `[aria-controls="${CSS.escape(content.id)}"]`
      )
    : null;
}

/**
 * `onCloseAutoFocus` for Radix menus, selects and popovers. On close they
 * return focus to their trigger on a `setTimeout(0)` — by then an item may
 * have opened a dialog that already focused itself, and the trigger sits
 * behind that dialog. Leave focus where the dialog put it, and make the
 * trigger that dialog's restore target instead.
 */
export function keepDialogFocusOnLayerClose(
  event: Event,
  onCloseAutoFocus?: (event: Event) => void
): void {
  onCloseAutoFocus?.(event);
  if (!isFocusInDialog()) return;
  event.preventDefault();
  const dialog = document.activeElement?.closest('[role="dialog"]');
  const trigger = layerTrigger(event.currentTarget as Element | null);
  // A menu inside the dialog itself (an item that focused one of its fields)
  // is not the dialog's opener.
  if (dialog && trigger && !dialog.contains(trigger)) {
    layerOpeners.set(dialog, trigger);
  }
}

// Node.DOCUMENT_POSITION_FOLLOWING
const DOCUMENT_POSITION_FOLLOWING = 4;

function portalRoot(el: Element): Element {
  let root = el;
  while (root.parentElement && root.parentElement !== document.body) {
    root = root.parentElement;
  }
  return root;
}

/**
 * Whether `target` sits in a layer stacked above the dialog `container`.
 * Layers (menus, selects, popovers, nested dialogs) portal into <body> when
 * they open, so anything opened after this dialog follows its portal root in
 * DOM order; the app tree and earlier layers precede it — they are behind.
 */
export function isLayeredAbove(container: Element, target: Element): boolean {
  const dialogRoot = portalRoot(container);
  const targetRoot = portalRoot(target);
  return (
    targetRoot === dialogRoot ||
    !!(
      dialogRoot.compareDocumentPosition(targetRoot) &
      DOCUMENT_POSITION_FOLLOWING
    )
  );
}

interface DialogFocusGuardOptions {
  /** Ref accessor for the dialog container element. Must be stable. */
  getContainer: () => HTMLElement | null;
  /** Top-of-stack check from useModalKeyboardLayer. */
  isTopLayer: () => boolean;
}

/**
 * Keeps focus inside the top-most dialog. Something behind it can still grab
 * focus after it opened — a closing menu refocusing its trigger, a background
 * `autoFocus` mounting after a load — and from there keys drive the page
 * behind the modal. Layers stacked above (see `isLayeredAbove`) are left
 * alone, so this is not a trap: menus and selects opened from the dialog work.
 */
export function useDialogFocusGuard({
  getContainer,
  isTopLayer,
}: DialogFocusGuardOptions) {
  useEffect(() => {
    let alive = true;
    let lastInside: HTMLElement | null = null;
    const container = getContainer();
    const active = document.activeElement as HTMLElement | null;
    if (container && active && container.contains(active)) lastInside = active;

    const reclaim = () => {
      const container = getContainer();
      if (!alive || !container || !isTopLayer()) return;
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        (container.contains(active) || isLayeredAbove(container, active))
      ) {
        return;
      }
      if (lastInside?.isConnected && container.contains(lastInside)) {
        lastInside.focus({ preventScroll: true });
      }
      // A disabled control declines focus; the container never does.
      if (!container.contains(document.activeElement)) {
        container.focus({ preventScroll: true });
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      const container = getContainer();
      const target = event.target as HTMLElement | null;
      if (!container || !target) return;
      if (container.contains(target)) {
        lastInside = target;
        return;
      }
      if (!isTopLayer() || isLayeredAbove(container, target)) return;
      // Deferred: a handler may move focus behind on purpose right before
      // closing this dialog (quick chat focuses the pane it opened, then
      // hides) — by the next task that close has committed and `alive` is off.
      setTimeout(reclaim, 0);
    };
    document.addEventListener('focusin', handleFocusIn);
    return () => {
      alive = false;
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, [getContainer, isTopLayer]);
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
