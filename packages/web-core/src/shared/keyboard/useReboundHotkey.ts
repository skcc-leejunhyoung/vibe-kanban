import type { DependencyList } from 'react';
import {
  useHotkeys,
  type HotkeyCallback,
  type Options,
} from 'react-hotkeys-hook';

// Sentinel key used when a binding is cleared. react-hotkeys-hook needs a
// parseable key string, so we pass this and force enabled:false; it never
// fires because the hook is disabled.
const DISABLED_SENTINEL = 'f13';

/**
 * useHotkeys wrapper that honors rebindable bindings:
 *  - an empty `keys` string means the binding is disabled (cleared by the user),
 *    so the hotkey is registered disabled and never fires.
 *  - any non-empty value (sequence 'w>a' or combo 'mod+a') is passed straight
 *    through to react-hotkeys-hook, which handles both syntaxes.
 *  - a modifier combo ('mod+a') additionally fires while an input / textarea /
 *    contentEditable is focused (like the native command-bar listener), since a
 *    combo doesn't clash with typing. Plain sequences stay disabled in form
 *    fields so their leading key isn't hijacked from the text being typed.
 *
 * `options.enabled` (when a boolean) is still respected and AND-ed with the
 * non-empty check. Explicit `preventDefault` / `enableOnFormTags` /
 * `enableOnContentEditable` options still win over the combo defaults.
 */
export function useReboundHotkey(
  keys: string,
  callback: HotkeyCallback,
  options: Options,
  dependencies: DependencyList
) {
  const optionEnabled =
    typeof options.enabled === 'boolean' ? options.enabled : true;
  const enabled = keys.length > 0 && optionEnabled;
  // A modifier combo (contains '+') doesn't clash with typing, so when a binding
  // resolves to one we (a) preventDefault so the shortcut wins over the browser
  // default, and (b) let it fire inside form fields / contentEditable — matching
  // the native command-bar listener (Cmd/Ctrl+K). Plain two-key sequences ('w>a')
  // keep the defaults: callers preventDefault themselves, and the hook stays
  // disabled in form fields so the leading key isn't hijacked from typed text.
  const isCombo = keys.includes('+');
  const preventDefault = options.preventDefault ?? isCombo;
  const enableOnFormTags = options.enableOnFormTags ?? isCombo;
  const enableOnContentEditable = options.enableOnContentEditable ?? isCombo;
  useHotkeys(
    keys || DISABLED_SENTINEL,
    callback,
    {
      ...options,
      enabled,
      preventDefault,
      enableOnFormTags,
      enableOnContentEditable,
    },
    dependencies
  );
}
