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
 *
 * `options.enabled` (when a boolean) is still respected and AND-ed with the
 * non-empty check.
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
  // When a binding is rebound to a modifier combo (e.g. 'mod+s'), prevent the
  // browser default so the shortcut wins. Plain two-key sequences keep the
  // caller's behavior (the callers preventDefault themselves where needed).
  const preventDefault = options.preventDefault ?? keys.includes('+');
  useHotkeys(
    keys || DISABLED_SENTINEL,
    callback,
    { ...options, enabled, preventDefault },
    dependencies
  );
}
