import * as React from 'react';
import { X } from 'lucide-react';
import { useHotkeys } from 'react-hotkeys-hook';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';

import { cn } from '../lib/cn';
import { useModalKeyboardLayer } from '../lib/modal-keyboard';
import {
  findDialogPrimaryAction,
  restoreDialogFocus,
  useDialogKeyboard,
} from '../lib/dialog-keyboard';
import {
  getKeyboardDialogMaxWidth,
  type KeyboardDialogSize,
} from '../lib/keyboard-dialog-size';

export type { KeyboardDialogSize } from '../lib/keyboard-dialog-size';

const DIALOG_SCOPE = 'dialog';

// Width belongs to the outer dialog, not DialogContent. Apply it inline so
// callers never need competing max-w-* classes; `cn` is clsx-only and cannot
// resolve Tailwind width conflicts reliably.

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  if (ref) {
    ref.current = value;
  }
}

const Dialog = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    uncloseable?: boolean;
    size?: KeyboardDialogSize;
    scrollMode?: 'viewport' | 'content';
    /** Edge-to-edge media viewer: no panel chrome, black backdrop. */
    fullscreen?: boolean;
  }
>(
  (
    {
      className,
      open,
      onOpenChange,
      children,
      uncloseable,
      size = 'xl',
      scrollMode = 'viewport',
      fullscreen = false,
      style,
      ...props
    },
    ref
  ) => {
    const { isTopLayer, isOverPointerBlockingLayer } =
      useModalKeyboardLayer(!!open);
    const dialogRef = React.useRef<HTMLDivElement | null>(null);
    const openerRef = React.useRef<HTMLElement | null>(null);

    const setDialogRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        dialogRef.current = node;
        assignRef(ref, node);
      },
      [ref]
    );

    // Escape (close), Cmd/Ctrl+Enter (primary action) and Tab (focus trap)
    // via the shared dialog keyboard layer — native document listeners so
    // they still fire while an input/textarea/contentEditable is focused
    // (react-hotkeys-hook ignores form fields by default, which is why
    // dialogs that autofocus an input used to swallow the first Escape).
    // Stacked dialogs stay consistent through the open-dialog stack gate:
    // only the top-most dialog reacts, so Escape peels dialogs inner-first.
    const getContainer = React.useCallback(() => dialogRef.current, []);
    const handleClose = React.useMemo(() => {
      if (uncloseable || !onOpenChange) return null;
      return () => onOpenChange(false);
    }, [uncloseable, onOpenChange]);
    useDialogKeyboard({
      open: !!open,
      getContainer,
      isTopLayer,
      onClose: handleClose,
    });

    // Focus management runs through Radix's FocusScope (trapping stays with
    // useDialogKeyboard) so this dialog joins the same focus-scope stack as
    // Radix dialogs: a Radix modal underneath (e.g. the command bar) is
    // paused instead of pulling focus back to its own input.
    //
    // On open, FocusScope raises this only when nothing inside is focused yet
    // (dialogs that autofocus their own field keep it). Focus the button that
    // Enter activates — an OK-only alert lands on OK — else the container, so
    // keys don't leak into whatever was focused before (e.g. the chat box).
    const handleMountAutoFocus = React.useCallback((event: Event) => {
      event.preventDefault();
      const el = dialogRef.current;
      if (!el) return;
      openerRef.current = document.activeElement as HTMLElement | null;
      (findDialogPrimaryAction(el) ?? el).focus();
    }, []);
    // On close, hand focus back to the opener ourselves: Radix's default also
    // select()s text inputs, which would clobber a draft on the next keystroke.
    // Always preventDefault — the fallback would target the same opener, so
    // letting it run would defeat restoreDialogFocus declining.
    const handleUnmountAutoFocus = React.useCallback((event: Event) => {
      event.preventDefault();
      const opener = openerRef.current;
      openerRef.current = null;
      restoreDialogFocus(opener);
    }, []);

    useHotkeys(
      'enter',
      (e) => {
        if (!open || !isTopLayer()) return;

        const activeElement = document.activeElement as HTMLElement;
        if (activeElement?.tagName === 'TEXTAREA') {
          return;
        }

        const container = dialogRef.current;
        if (!container) {
          return;
        }

        // Structural resolution first (marker/submit/single button); legacy
        // text heuristic only as a last resort for dialogs that predate
        // explicit footer button types. The text match is English-only, so
        // explicit types are the reliable path (ko labels never match).
        const legacyPrimaryButton = () =>
          (
            Array.from(
              container.querySelectorAll('button')
            ) as HTMLButtonElement[]
          ).find(
            (btn) =>
              !btn.disabled &&
              !btn.textContent?.toLowerCase().includes('cancel') &&
              !btn.textContent?.toLowerCase().includes('close') &&
              btn.type !== 'button'
          ) ?? null;
        const primaryButton =
          findDialogPrimaryAction(container) ?? legacyPrimaryButton();

        if (primaryButton) {
          e?.preventDefault();
          primaryButton.click();
        }
      },
      {
        enabled: !!open,
        scopes: [DIALOG_SCOPE],
      },
      [open, isTopLayer]
    );

    if (!open) return null;

    // A Radix modal underneath sets `pointer-events: none` on <body>; opt back
    // in only then, so a Radix select/menu opened *above* us still inerts us.
    const liftPointerEvents = isOverPointerBlockingLayer();

    return createPortal(
      <div
        className={cn(
          'fixed inset-0 z-[10000] flex items-start justify-center p-4',
          scrollMode === 'content' ? 'overflow-hidden' : 'overflow-y-auto'
        )}
        style={liftPointerEvents ? { pointerEvents: 'auto' } : undefined}
      >
        <div
          data-tauri-drag-region
          className="fixed inset-0 bg-black/50"
          onClick={() => (uncloseable ? {} : onOpenChange?.(false))}
        />
        <FocusScope
          asChild
          trapped={false}
          onMountAutoFocus={handleMountAutoFocus}
          onUnmountAutoFocus={handleUnmountAutoFocus}
        >
          <div
            ref={setDialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            className={cn(
              'z-[10000] flex w-full flex-col outline-none duration-200',
              fullscreen
                ? 'fixed inset-0 bg-black text-white'
                : 'relative my-8 gap-4 bg-primary p-6 shadow-lg sm:rounded-lg',
              className
            )}
            style={{
              ...style,
              maxWidth: fullscreen ? 'none' : getKeyboardDialogMaxWidth(size),
            }}
            {...props}
          >
            {!uncloseable && (
              <button
                type="button"
                className={cn(
                  'absolute right-4 z-10 opacity-70 transition-opacity hover:opacity-100',
                  fullscreen
                    ? 'top-[max(1rem,env(safe-area-inset-top))] rounded-full bg-black/50 p-2'
                    : 'top-4 rounded-sm'
                )}
                onClick={() => onOpenChange?.(false)}
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </button>
            )}
            {children}
          </div>
        </FocusScope>
      </div>,
      document.body
    );
  }
);
Dialog.displayName = 'Dialog';

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col space-y-1.5 text-center sm:text-left',
      className
    )}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-none tracking-tight',
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex flex-col gap-4', className)} {...props} />
));
DialogContent.displayName = 'DialogContent';

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2',
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
};
