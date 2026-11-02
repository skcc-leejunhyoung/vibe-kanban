// Two dialog widths, picked by purpose:
// - compact: confirm, form, picker and command palette dialogs.
// - wide: reading/working surfaces (settings, quick chat, logs, transcripts).
// `full` is reserved for edge-to-edge viewers (PR details, media).
// Hand-rolled shells (SettingsDialog, KeyboardShortcutsDialog,
// GuideDialogShell) hard-code the wide value as `w-[56rem]`; keep them in sync.
export type DialogSize = 'compact' | 'wide' | 'full';

const DIALOG_MAX_WIDTHS: Record<DialogSize, string> = {
  compact: '32rem',
  wide: '56rem',
  full: 'none',
};

export function getDialogMaxWidth(size: DialogSize): string {
  return DIALOG_MAX_WIDTHS[size];
}
