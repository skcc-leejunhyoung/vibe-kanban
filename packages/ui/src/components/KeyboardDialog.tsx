import * as React from 'react';
import { X } from 'lucide-react';
import { useHotkeys, useHotkeysContext } from 'react-hotkeys-hook';
import { createPortal } from 'react-dom';

import { cn } from '../lib/cn';

const DIALOG_SCOPE = 'dialog';
const KANBAN_SCOPE = 'kanban';
const PROJECTS_SCOPE = 'projects';

// Stack of currently-open KeyboardDialog instances. Escape only closes the
// top-most (most recently opened) one. Stacked dialogs all listen on `document`
// in the bubble phase, where listeners fire in registration order (outer first),
// so without this gate Escape would wrongly close the OUTER dialog and orphan
// the inner one. Identity is a per-instance symbol pushed while the dialog is
// open.
const openDialogStack: symbol[] = [];

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
  }
>(({ className, open, onOpenChange, children, uncloseable, ...props }, ref) => {
  const { enableScope, disableScope } = useHotkeysContext();
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const dialogIdRef = React.useRef<symbol | null>(null);
  if (dialogIdRef.current === null) {
    dialogIdRef.current = Symbol('keyboard-dialog');
  }

  const setDialogRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      dialogRef.current = node;
      assignRef(ref, node);
    },
    [ref]
  );

  // Manage dialog scope when open/closed
  React.useEffect(() => {
    if (open) {
      enableScope(DIALOG_SCOPE);
      disableScope(KANBAN_SCOPE);
      disableScope(PROJECTS_SCOPE);
    } else {
      disableScope(DIALOG_SCOPE);
      enableScope(KANBAN_SCOPE);
      enableScope(PROJECTS_SCOPE);
    }
    return () => {
      disableScope(DIALOG_SCOPE);
      enableScope(KANBAN_SCOPE);
      enableScope(PROJECTS_SCOPE);
    };
  }, [open, enableScope, disableScope]);

  // Track this dialog in the open-dialog stack while it is open. Depends only on
  // `open`/`uncloseable` so the stack order is stable even when `onOpenChange` is
  // recreated on a parent re-render (which re-runs the Escape effect below).
  React.useEffect(() => {
    if (!open || uncloseable) return;
    const id = dialogIdRef.current!;
    openDialogStack.push(id);
    return () => {
      const idx = openDialogStack.lastIndexOf(id);
      if (idx !== -1) openDialogStack.splice(idx, 1);
    };
  }, [open, uncloseable]);

  // Close on Escape. We use a native document listener (bubble phase) instead
  // of `useHotkeys` so Escape still fires while an input/textarea/contentEditable
  // is focused — react-hotkeys-hook ignores form fields by default, which is why
  // dialogs that autofocus an input used to swallow the first Escape entirely.
  //
  // Nested dismissable layers cooperate via the event: Radix popovers/selects/
  // dropdowns handle Escape in the capture phase and `preventDefault()` when they
  // dismiss, and custom dropdowns `stopPropagation()`, so an inner layer always
  // gets first claim on the key and our handler then skips via `defaultPrevented`.
  // For two stacked KeyboardDialogs both listening on `document`, the outer one's
  // listener runs first (registered first), so we additionally gate on the
  // open-dialog stack: only the top-most dialog closes, leaving Escape to peel
  // dialogs off inner-first.
  React.useEffect(() => {
    if (!open || uncloseable) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!onOpenChange) return;
      if (openDialogStack[openDialogStack.length - 1] !== dialogIdRef.current) {
        return;
      }
      event.preventDefault();
      onOpenChange(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, uncloseable, onOpenChange]);

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
      if (!open) return;

      const activeElement = document.activeElement as HTMLElement;
      if (activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      const container = dialogRef.current;
      if (!container) {
        return;
      }

      const submitButton = container.querySelector(
        'button[type="submit"]'
      ) as HTMLButtonElement | null;
      if (submitButton && !submitButton.disabled) {
        e?.preventDefault();
        submitButton.click();
        return;
      }

      const buttons = Array.from(
        container.querySelectorAll('button')
      ) as HTMLButtonElement[];
      const primaryButton = buttons.find(
        (btn) =>
          !btn.disabled &&
          !btn.textContent?.toLowerCase().includes('cancel') &&
          !btn.textContent?.toLowerCase().includes('close') &&
          btn.type !== 'button'
      );

      if (primaryButton) {
        e?.preventDefault();
        primaryButton.click();
      }
    },
    {
      enabled: !!open,
      scopes: [DIALOG_SCOPE],
    },
    [open]
  );

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-start justify-center p-4 overflow-y-auto">
      <div
        data-tauri-drag-region
        className="fixed inset-0 bg-black/50"
        onClick={() => (uncloseable ? {} : onOpenChange?.(false))}
      />
      <div
        ref={setDialogRef}
        tabIndex={-1}
        className={cn(
          'relative z-[10000] flex flex-col w-full max-w-xl gap-4 bg-primary p-6 shadow-lg duration-200 sm:rounded-lg my-8 outline-none',
          className
        )}
        {...props}
      >
        {!uncloseable && (
          <button
            className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 z-10"
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
});
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
