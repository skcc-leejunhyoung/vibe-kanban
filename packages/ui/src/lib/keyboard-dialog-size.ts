export type KeyboardDialogSize =
  | 'sm'
  | 'md'
  | 'lg'
  | 'xl'
  | '2xl'
  | '3xl'
  | '4xl'
  | '5xl'
  | 'full';

const KEYBOARD_DIALOG_MAX_WIDTHS: Record<KeyboardDialogSize, string> = {
  sm: '24rem',
  md: '28rem',
  lg: '32rem',
  xl: '36rem',
  '2xl': '42rem',
  '3xl': '48rem',
  '4xl': '56rem',
  '5xl': '64rem',
  full: 'none',
};

export function getKeyboardDialogMaxWidth(size: KeyboardDialogSize): string {
  return KEYBOARD_DIALOG_MAX_WIDTHS[size];
}
