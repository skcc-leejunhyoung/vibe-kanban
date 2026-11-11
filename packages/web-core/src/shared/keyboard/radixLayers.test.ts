import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const fromUi = createRequire(
  new URL('../../../../ui/package.json', import.meta.url)
);
const fromDialog = createRequire(fromUi.resolve('@radix-ui/react-dialog'));
const fromDropdown = createRequire(
  fromUi.resolve('@radix-ui/react-dropdown-menu')
);
const fromMenu = createRequire(fromDropdown.resolve('@radix-ui/react-menu'));

describe('Radix dismissable layers', () => {
  it.each([
    ['menu', fromMenu],
    ['popover', createRequire(fromUi.resolve('@radix-ui/react-popover'))],
    ['select', createRequire(fromUi.resolve('@radix-ui/react-select'))],
    ['tooltip', createRequire(fromUi.resolve('@radix-ui/react-tooltip'))],
  ] as const)('%s shares the dialog layer stack', (_name, fromPrimitive) => {
    // Separate module instances each treat their own layer as topmost.
    expect(fromPrimitive.resolve('@radix-ui/react-dismissable-layer')).toBe(
      fromDialog.resolve('@radix-ui/react-dismissable-layer')
    );
  });
});
