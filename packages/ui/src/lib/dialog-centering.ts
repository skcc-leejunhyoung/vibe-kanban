// Class names that center the Radix dialog (`./components/Dialog.tsx`).
//
// IMPORTANT — why centering does NOT use `transform: translate(-50%, -50%)`:
//
// The common shadcn pattern centers the dialog content with
// `fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`. A persistent
// `transform` promotes the content to its own GPU compositing layer. Whenever
// the centered box lands on a fractional *device* pixel, that layer's texture
// is bilinear-sampled, which visibly softens text and borders. The box lands on
// a half pixel surprisingly often:
//   - an odd-width dialog (e.g. ErrorDialog's `sm:max-w-[425px]`) on an
//     even-width viewport: left = (vw - 425) / 2 => *.5px, or
//   - any width when `devicePixelRatio` is fractional (1.25 / 1.5 display
//     scaling).
// Because it depends on viewport-width parity, the blur toggled on and off as
// the window was resized — which is exactly the "warning dialog sometimes looks
// low-quality" report.
//
// Centering instead via a flex wrapper keeps the content free of any persistent
// transform, so its glyphs are rasterized directly to the screen (with normal
// hinting / sub-pixel AA) and stay crisp even when the box origin is a half
// pixel. This mirrors the already-correct flex centering in
// `./components/KeyboardDialog.tsx`.
//
// Do NOT reintroduce `translate-*`/`left-1/2`/`top-1/2` centering on the
// content — see `dialog-centering.test.ts`.

export const dialogCenteringWrapperClasses =
  'fixed inset-0 flex items-center justify-center p-4 pointer-events-none';

// Default stacking for the centering wrapper. Sits above the dialog's dim
// overlay (z-[9998]) and below the floating layer (dropdowns / popovers /
// selects at z-[10000]) so those still open on top of a dialog. Applied as an
// inline style — `cn` is clsx-only (no tailwind-merge), so a `z-[…]` class
// override would not dedupe the default and CSS source order would decide.
// Dialogs that must clear the z-[10000] layer (e.g. ErrorDialog) pass a higher
// `wrapperZIndex`.
export const DIALOG_WRAPPER_Z_INDEX = 9999;

export const dialogContentBaseClasses = [
  'relative pointer-events-auto',
  'w-full max-w-lg bg-panel border border-border rounded-sm shadow-lg',
  'data-[state=open]:animate-in data-[state=closed]:animate-out',
  'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
  'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
  'duration-200',
].join(' ');
