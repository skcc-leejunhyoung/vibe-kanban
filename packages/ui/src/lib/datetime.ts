/**
 * Fixed display time zone for all user-facing timestamps.
 *
 * Vibe Kanban code runs in several places with different ambient time zones:
 * the user's browser, the local server, and the remote server (which runs in a
 * UTC Docker container). Formatting with the runtime's implicit time zone
 * therefore yields inconsistent results depending on where the code runs or
 * which device the UI is opened on.
 *
 * To make every timestamp read the same — including the codex/claude
 * usage-limit reset times surfaced by the auto-resume control — all
 * user-facing date/time formatting is pinned to Korea Standard Time. Pass this
 * as the `timeZone` option to `Intl`/`toLocale*` formatters instead of relying
 * on the ambient zone.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Seoul';

/**
 * Merge {@link DISPLAY_TIME_ZONE} into `toLocale*` / `Intl.DateTimeFormat`
 * options so callers don't have to repeat the constant. The caller's own
 * `timeZone`, if any, is intentionally overridden — display is always KST.
 */
export function withDisplayTimeZone(
  options: Intl.DateTimeFormatOptions = {}
): Intl.DateTimeFormatOptions {
  return { ...options, timeZone: DISPLAY_TIME_ZONE };
}
