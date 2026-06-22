import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../lib/cn';

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
  // Close on Escape, matching the backdrop click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return createPortal(
    <>
      {/* Backdrop overlay */}
      <div
        data-tauri-drag-region
        className={cn(
          'fixed inset-0 bg-black/50 z-[100]',
          'transition-opacity duration-200 ease-out',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer panel */}
      <div
        className={cn(
          'fixed left-0 top-0 h-full w-[280px] bg-primary z-[101]',
          'pb-[env(safe-area-inset-bottom)]',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : '-translate-x-full pointer-events-none'
        )}
      >
        {children}
      </div>
    </>,
    document.body
  );
}
