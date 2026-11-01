import { useRef, useState, type ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn';
import { getModifierKey } from '../lib/platform';

interface TooltipProps {
  children: ReactNode;
  content: ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  openOnClick?: boolean;
}

export function Tooltip({
  children,
  content,
  shortcut,
  side = 'bottom',
  className,
  openOnClick = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const openOnPointerDown = useRef(false);
  const formattedShortcut = shortcut?.replace('{mod}', getModifierKey());

  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root
        open={openOnClick ? open : undefined}
        onOpenChange={openOnClick ? setOpen : undefined}
      >
        <TooltipPrimitive.Trigger
          asChild
          aria-expanded={openOnClick ? open : undefined}
          onPointerDown={
            openOnClick
              ? () => {
                  // Capture before Radix closes and clears its hover timer.
                  openOnPointerDown.current = open;
                }
              : undefined
          }
          onClick={
            openOnClick
              ? (event) => {
                  event.preventDefault();
                  setOpen(
                    !(event.detail === 0 ? open : openOnPointerDown.current)
                  );
                }
              : undefined
          }
        >
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={4}
            className={cn(
              'z-[10000] flex items-center rounded-sm bg-panel px-base py-half text-xs text-normal shadow-md',
              'animate-in fade-in-0 zoom-in-95',
              className
            )}
          >
            <span>{content}</span>
            {formattedShortcut && (
              <kbd
                className={cn(
                  'ml-2 inline-flex items-center gap-0.5 px-2 py-0.5',
                  'rounded-sm border border-border bg-secondary',
                  'font-ibm-plex-mono text-xs text-high'
                )}
              >
                {formattedShortcut}
              </kbd>
            )}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
