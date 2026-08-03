import * as React from 'react';
import { X } from 'lucide-react';
import { useHotkeys } from 'react-hotkeys-hook';
import { createPortal } from 'react-dom';

import { cn } from '../lib/cn';
import { useModalKeyboardLayer } from '../lib/modal-keyboard';
import {
  findDialogPrimaryAction,
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
      style,
      ...props
    },
    ref
  ) => {
    const { isTopLayer } = useModalKeyboardLayer(!!open);
    const dialogRef = React.useRef<HTMLDivElement | null>(null);

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

    // Move focus into the dialog when it opens. KeyboardDialog is a custom (non-
    // Radix) implementation with no built-in focus management, so otherwise focus
    // stays on whatever was focused before — e.g. the workspace chat input (a
    // Lexical contentEditable). react-hotkeys-hook ignores keys fired from form
    // fields/contentEditable, so the dialog's Enter shortcut never ran and the
    // keystroke leaked into the chat box instead. Focusing the dialog container
    // (unless the dialog autofocused a field of its own) fixes both, and we
    // restore the prior focus on close so the chat input stays usable.
    React.useEffect(() => {
      if (!open) return;
      const active = document.activeElement as HTMLElement | null;
      // Remember external focus (e.g. the chat input) to restore on close; ignore
      // focus that's already inside the dialog (a field it autofocused itself).
      const previouslyFocused =
        active && !dialogRef.current?.contains(active) ? active : null;

      const raf = requestAnimationFrame(() => {
        const el = dialogRef.current;
        if (el && !el.contains(document.activeElement)) {
          el.focus();
        }
      });

      return () => {
        cancelAnimationFrame(raf);
        if (previouslyFocused?.isConnected) {
          previouslyFocused.focus?.();
        }
      };
    }, [open]);

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

    return createPortal(
      <div
        className={cn(
          'fixed inset-0 z-[10000] flex items-start justify-center p-4',
          scrollMode === 'content' ? 'overflow-hidden' : 'overflow-y-auto'
        )}
      >
        <div
          data-tauri-drag-region
          className="fixed inset-0 bg-black/50"
          onClick={() => (uncloseable ? {} : onOpenChange?.(false))}
        />
        <div
          ref={setDialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          className={cn(
            'relative z-[10000] flex flex-col w-full gap-4 bg-primary p-6 shadow-lg duration-200 sm:rounded-lg my-8 outline-none',
            className
          )}
          style={{ ...style, maxWidth: getKeyboardDialogMaxWidth(size) }}
          {...props}
        >
          {!uncloseable && (
            <button
              type="button"
              className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 z-10"
              onClick={() => onOpenChange?.(false)}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          )}
          {children}
        </div>
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
