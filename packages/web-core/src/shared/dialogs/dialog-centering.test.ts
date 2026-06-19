import { describe, expect, it } from 'vitest';
import {
  DIALOG_WRAPPER_Z_INDEX,
  dialogCenteringWrapperClasses,
  dialogContentBaseClasses,
} from '@vibe/ui/lib/dialog-centering';

// Regression guard for the "warning dialog sometimes looks low-quality" bug.
//
// The Radix dialog (`@vibe/ui/components/Dialog`, used by ErrorDialog, the
// command bar, the kanban filters dialog, …) used to center its content with
// `fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`. That persistent
// `transform` composites the content; when the centered box lands on a
// fractional device pixel (an odd-width dialog on an even-width viewport, or any
// width at fractional devicePixelRatio) the layer texture is bilinear-sampled
// and text/borders go soft. The blur flipped with viewport-width parity, which
// is why it only showed up "sometimes". Centering is now done by a flex wrapper
// so the content carries no persistent transform and stays crisp.
//
// These assertions fail loudly if transform-based centering is reintroduced
// (e.g. by re-syncing with the upstream shadcn dialog).

// Tokens that put a persistent translate-centering transform on the content.
const TRANSFORM_CENTERING_TOKENS = [
  'translate-x-[-50%]',
  'translate-y-[-50%]',
  '-translate-x-1/2',
  '-translate-y-1/2',
  'left-[50%]',
  'top-[50%]',
  'left-1/2',
  'top-1/2',
];

describe('dialog centering classes', () => {
  it('centers the dialog with a flex wrapper (no transform on the content)', () => {
    for (const token of [
      'fixed',
      'inset-0',
      'flex',
      'items-center',
      'justify-center',
    ]) {
      expect(dialogCenteringWrapperClasses).toContain(token);
    }
  });

  it('never centers the content with a persistent transform (causes sub-pixel blur)', () => {
    for (const token of TRANSFORM_CENTERING_TOKENS) {
      expect(
        dialogContentBaseClasses,
        `dialog content must not center with "${token}" — a persistent transform ` +
          `composites the content and bilinear-samples it on fractional device ` +
          `pixels, softening text. Center via the flex wrapper instead.`
      ).not.toContain(token);
    }
    // The content must not be its own fixed layer; the wrapper owns positioning.
    expect(dialogContentBaseClasses).not.toContain('fixed');
  });

  it('keeps the panel styling and open/close animation on the content', () => {
    for (const token of [
      'bg-panel',
      'rounded-sm',
      'data-[state=open]:animate-in',
      'data-[state=open]:fade-in-0',
    ]) {
      expect(dialogContentBaseClasses).toContain(token);
    }
  });

  // The wrapper owns stacking (it is a `position: fixed` stacking context, so a
  // z-index on the content can't escape it). The default must sit above the dim
  // overlay (z-[9998]) yet below the floating layer (dropdowns / popovers /
  // selects at z-[10000]) so those still open on top of a dialog. Dialogs that
  // must clear the floating layer (e.g. ErrorDialog, wrapperZIndex={10001}) opt
  // in explicitly.
  it('defaults the wrapper z-index between the overlay and the floating layer', () => {
    const OVERLAY_Z = 9998;
    const FLOATING_LAYER_Z = 10000;
    expect(DIALOG_WRAPPER_Z_INDEX).toBeGreaterThan(OVERLAY_Z);
    expect(DIALOG_WRAPPER_Z_INDEX).toBeLessThan(FLOATING_LAYER_Z);
    // The wrapper z is applied via inline style, never baked into the class
    // string — `cn` is clsx-only, so a `z-[…]` class could not be overridden.
    expect(dialogCenteringWrapperClasses).not.toContain('z-[');
  });
});
