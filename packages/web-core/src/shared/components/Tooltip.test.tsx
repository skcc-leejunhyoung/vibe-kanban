import {
  act,
  type ComponentProps,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';

let rootProps: ComponentProps<typeof TooltipPrimitive.Root>;
let triggerProps: ComponentProps<typeof TooltipPrimitive.Trigger>;
vi.mock('@radix-ui/react-tooltip', () => ({
  Provider: ({ children }: ComponentProps<typeof TooltipPrimitive.Provider>) =>
    children,
  Root: (props: typeof rootProps) => {
    rootProps = props;
    return props.children;
  },
  Trigger: (props: typeof triggerProps) => {
    triggerProps = props;
    return null;
  },
  Portal: () => null,
  Content: () => null,
}));

let dom: ReturnType<typeof installDomlessReact>;
beforeEach(() => {
  dom = installDomlessReact();
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

describe('clickable Tooltip', () => {
  it('toggles on repeated taps without Radix immediately closing or reopening it', async () => {
    await dom.render(
      <Tooltip content="Usage" openOnClick>
        {null}
      </Tooltip>
    );
    for (const expected of [true, false]) {
      const pointer = new Event('pointerdown', { cancelable: true });
      const click = new Event('click', { cancelable: true });
      await act(() => {
        triggerProps.onPointerDown?.(
          pointer as unknown as PointerEvent<HTMLButtonElement>
        );
        rootProps.onOpenChange?.(false);
      });
      await act(() => {
        triggerProps.onClick?.(
          click as unknown as MouseEvent<HTMLButtonElement>
        );
      });
      expect(pointer.defaultPrevented).toBe(false);
      expect(click.defaultPrevented).toBe(true);
      expect(rootProps.open).toBe(expected);
      expect(triggerProps['aria-expanded']).toBe(expected);
    }
  });

  it('keeps hover, focus, Escape and outside dismissal connected to the same popup', async () => {
    await dom.render(
      <Tooltip content="Usage" openOnClick>
        {null}
      </Tooltip>
    );
    await act(() => rootProps.onOpenChange?.(true));
    expect(rootProps.open).toBe(true);
    await act(() => rootProps.onOpenChange?.(false));
    expect(rootProps.open).toBe(false);
  });

  it('leaves ordinary tooltips under Radix control', async () => {
    await dom.render(<Tooltip content="Usage">{null}</Tooltip>);
    expect(rootProps.open).toBeUndefined();
    expect(triggerProps.onPointerDown).toBeUndefined();
    expect(triggerProps.onClick).toBeUndefined();
    expect(triggerProps['aria-expanded']).toBeUndefined();
  });

  it('uses the current open state for keyboard activation without a pointer event', async () => {
    await dom.render(
      <Tooltip content="Usage" openOnClick>
        {null}
      </Tooltip>
    );
    await act(() => rootProps.onOpenChange?.(true));
    const click = Object.assign(new Event('click', { cancelable: true }), {
      detail: 0,
    });
    await act(() => {
      triggerProps.onClick?.(click as unknown as MouseEvent<HTMLButtonElement>);
    });
    expect(rootProps.open).toBe(false);
    expect(click.defaultPrevented).toBe(true);
  });
});
