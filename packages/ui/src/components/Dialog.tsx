import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  DIALOG_WRAPPER_Z_INDEX,
  dialogCenteringWrapperClasses,
  dialogContentBaseClasses,
} from '../lib/dialog-centering';
import { useModalKeyboardLayer } from '../lib/modal-keyboard';
import {
  findDialogPrimaryAction,
  isDialogConfirmKey,
  markEscapeDeferred,
} from '../lib/dialog-keyboard';

// Shares the modal-stack top check with DialogContent so Escape/confirm only
// react on the top-most dialog when Radix and KeyboardDialog stacks mix.
const DialogLayerContext = React.createContext<(() => boolean) | null>(null);

function Dialog({
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isOpen = open ?? internalOpen;
  const { isTopLayer } = useModalKeyboardLayer(isOpen);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setInternalOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [open, onOpenChange]
  );

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={handleOpenChange}
      {...props}
    >
      <DialogLayerContext.Provider value={isTopLayer}>
        {children}
      </DialogLayerContext.Provider>
    </DialogPrimitive.Root>
  );
}

const DialogTrigger = DialogPrimitive.Trigger;

const DialogClose = DialogPrimitive.Close;

function DialogPortal({
  children,
  ...props
}: DialogPrimitive.DialogPortalProps) {
  return <DialogPrimitive.Portal {...props}>{children}</DialogPrimitive.Portal>;
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-tauri-drag-region
    className={cn(
      'fixed inset-0 z-[9998] bg-black/50',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideCloseButton?: boolean;
    // z-index for the centering wrapper. Set this (not `style.zIndex` on the
    // content) to lift the whole dialog above the z-[10000] layer — the wrapper
    // is a `position: fixed` stacking context, so a z-index on the content
    // cannot escape it. e.g. ErrorDialog passes `wrapperZIndex={10001}`.
    wrapperZIndex?: number;
  }
>(
  (
    {
      className,
      children,
      hideCloseButton = false,
      wrapperZIndex = DIALOG_WRAPPER_Z_INDEX,
      onKeyDown,
      onEscapeKeyDown,
      ...props
    },
    ref
  ) => {
    const isTopLayer = React.useContext(DialogLayerContext);

    // Cmd/Ctrl+Enter activates the dialog's primary action. Radix keeps
    // focus inside the content, so a listener on the content sees every
    // keydown of this dialog — and only this dialog, since stacked dialogs
    // are portaled as sibling trees.
    const handleKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (!isDialogConfirmKey(event.nativeEvent)) return;
        const primary = findDialogPrimaryAction(event.currentTarget);
        if (!primary) return;
        event.preventDefault();
        primary.click();
      },
      [onKeyDown]
    );

    // Radix only coordinates Escape among its own layers; gate on the shared
    // modal stack so a KeyboardDialog stacked above doesn't close us too.
    // preventDefault() is how Radix is told to skip its close, but the flag
    // keeps the same keypress claimable by the top dialog's own listener.
    const handleEscapeKeyDown = React.useCallback(
      (event: KeyboardEvent) => {
        onEscapeKeyDown?.(event);
        if (isTopLayer && !isTopLayer()) {
          event.preventDefault();
          markEscapeDeferred(event);
        }
      },
      [onEscapeKeyDown, isTopLayer]
    );

    return (
      <DialogPortal>
        <DialogOverlay />
        {/*
          Center via a flex wrapper rather than a `transform` on the content.
          A persistent transform on the content composites it and
          bilinear-samples its texture whenever the centered box lands on a
          fractional device pixel, softening text — see ../lib/dialog-centering.ts.
        */}
        <div
          className={dialogCenteringWrapperClasses}
          style={{ zIndex: wrapperZIndex }}
        >
          <DialogPrimitive.Content
            ref={ref}
            className={cn(dialogContentBaseClasses, className)}
            onKeyDown={handleKeyDown}
            onEscapeKeyDown={handleEscapeKeyDown}
            {...props}
          >
            {children}
            {!hideCloseButton && (
              <DialogPrimitive.Close
                type="button"
                className="absolute right-base top-base rounded-sm opacity-70 transition-opacity hover:opacity-100 disabled:pointer-events-none"
              >
                <X className="h-4 w-4 text-normal" />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            )}
          </DialogPrimitive.Content>
        </div>
      </DialogPortal>
    );
  }
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

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

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      'text-lg font-semibold leading-none tracking-tight text-high',
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-normal', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
