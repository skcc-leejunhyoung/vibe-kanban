import { type KeyboardEventHandler, type ReactNode } from 'react';
import { type Icon, ImageIcon, SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { Toolbar } from './Toolbar';
import { Tooltip } from './Tooltip';

export enum VisualVariant {
  NORMAL = 'NORMAL',
  FEEDBACK = 'FEEDBACK',
  EDIT = 'EDIT',
  PLAN = 'PLAN',
}

export interface DropzoneProps {
  getRootProps: (props?: Record<string, unknown>) => Record<string, unknown>;
  getInputProps: () => Record<string, unknown>;
  isDragActive: boolean;
}

interface ChatBoxBaseProps {
  // Editor node (provided by frontend)
  editor: ReactNode;

  // Error display
  error?: string | null;

  // Header content (right side - session/executor dropdown)
  headerRight?: ReactNode;

  // Header content (left side - stats)
  headerLeft?: ReactNode;

  // Footer left content (additional toolbar items like attach button)
  footerLeft?: ReactNode;

  // Footer right content (action buttons)
  footerRight: ReactNode;

  // Model selector node (rendered inline after footerLeft)
  modelSelector?: ReactNode;

  // Banner content (queued message indicator, feedback mode indicator)
  banner?: ReactNode;

  // visualVariant
  visualVariant: VisualVariant;

  // Whether the workspace is running (shows animated border)
  isRunning?: boolean;

  // Dropzone props for drag-and-drop image uploads
  dropzone?: DropzoneProps;

  // Fill the parent's height and let the editor area shrink (with internal
  // scroll) so the footer stays visible on short viewports. The editor node
  // must be `flex-1 min-h-0` for this to take effect. Requires a
  // height-bounded parent.
  fillHeight?: boolean;

  // Keyboard handling shared by the editor and surrounding controls.
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>;
}

/**
 * Base chat box layout component.
 * Provides shared structure for CreateChatBox and SessionChatBox.
 */
export function ChatBoxBase({
  editor,
  error,
  headerRight,
  headerLeft,
  footerLeft,
  footerRight,
  modelSelector,
  banner,
  visualVariant,
  isRunning,
  dropzone,
  fillHeight = false,
  onKeyDown,
  onKeyDownCapture,
}: ChatBoxBaseProps) {
  const { t } = useTranslation(['common', 'tasks']);

  const isDragActive = dropzone?.isDragActive ?? false;
  const rootProps = dropzone?.getRootProps({
    onKeyDown,
    onKeyDownCapture,
  }) ?? { onKeyDown, onKeyDownCapture };

  return (
    <div
      {...rootProps}
      className={cn(
        'relative flex w-chat max-w-full flex-col overflow-hidden rounded-xl border border-border bg-secondary',
        (visualVariant === VisualVariant.FEEDBACK ||
          visualVariant === VisualVariant.EDIT ||
          visualVariant === VisualVariant.PLAN) &&
          'border-brand bg-brand/10',
        isRunning && 'chat-box-running',
        fillHeight && 'min-h-0 self-stretch'
      )}
    >
      {dropzone && <input {...dropzone.getInputProps()} />}

      {isDragActive && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-brand bg-primary/80 backdrop-blur-sm pointer-events-none animate-in fade-in-0 duration-150">
          <div className="text-center">
            <div className="mx-auto mb-2 w-10 h-10 rounded-full bg-brand/10 flex items-center justify-center">
              <ImageIcon className="h-5 w-5 text-brand" />
            </div>
            <p className="text-sm font-medium text-high">
              {t('tasks:dropzone.dropImagesHere')}
            </p>
            <p className="text-xs text-low mt-0.5">
              {t('tasks:dropzone.supportedFormats')}
            </p>
          </div>
        </div>
      )}
      {/* Error alert */}
      {error && (
        <div className="bg-error/10 border-b px-plusfifty py-half">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {/* Banner content (queued list, agent question, review comments). In a
          height-capped box this is the part that gives way: it shrinks and
          scrolls, so a long question or queue can't push the input and the
          action buttons out of the box. The divider lives on the wrapper (each
          banner's own bottom border is dropped on the last one) so it stays
          put while the banners scroll; `empty:hidden` covers a banner that
          renders nothing (e.g. an answered question awaiting the agent). */}
      {banner && (
        <div
          className={cn(
            'border-b empty:hidden [&>*:last-child]:border-b-0',
            fillHeight && 'min-h-0 overflow-y-auto'
          )}
        >
          {banner}
        </div>
      )}

      {/* Header - stats (left) and session controls (right), no divider */}
      {visualVariant === VisualVariant.NORMAL && (
        <div className="flex items-center gap-base px-plusfifty pt-base">
          <div className="flex flex-1 items-center gap-base text-sm min-w-0 overflow-hidden">
            {headerLeft}
          </div>
          <Toolbar className="shrink-0">{headerRight}</Toolbar>
        </div>
      )}

      {/* Editor area. `flex-auto` (basis = content) makes it share a squeeze
          with the banner in proportion to their sizes, and the floor keeps one
          line of input visible however long the banner is. The floor is
          exactly `pt-base` + one `text-base` line (1.5rem, scaled by the text
          size preference like the font token), so a one-line box is never
          taller than its content. The footer is deliberately NOT inside this
          element: when it was, squeezing the editor area squeezed the action
          buttons out of the box with it. */}
      <div
        className={cn(
          'flex flex-col px-plusfifty pt-base',
          fillHeight &&
            'min-h-[calc(0.5rem_+_1.5rem_*_var(--vk-text-scale,1))] flex-auto'
        )}
      >
        {editor}
      </div>

      {/* Footer - controls and action buttons share ONE wrapping flow, so a
          control that wraps takes the action buttons with it onto the same
          line instead of leaving a half-empty row. `ml-auto` is per-line in
          flexbox, so the buttons stay right-aligned on whichever line they
          land on. Nesting the controls in their own flex container would
          reintroduce the split: the whole group would claim the first line
          and push the buttons to a row of their own. */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-half px-plusfifty py-base',
          fillHeight && 'shrink-0'
        )}
      >
        {footerLeft}
        {modelSelector}
        <div className="ml-auto flex shrink-0 items-center gap-half">
          {footerRight}
        </div>
      </div>
    </div>
  );
}

interface ChatActionButtonProps {
  icon: Icon | 'spinner';
  /** Tooltip + accessible name; the button itself is icon-only. */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}

/** Round icon-only composer action (send / queue / stop). */
export function ChatActionButton({
  icon: ActionIcon,
  label,
  onClick,
  disabled,
  variant = 'primary',
}: ChatActionButtonProps) {
  return (
    // The span keeps the tooltip reachable while the button is disabled:
    // disabled controls swallow pointer events in Safari/Firefox, so a
    // Tooltip.Trigger on the button itself would never fire there and the
    // icon-only sending/stopping/loading states would read as a bare circle.
    <Tooltip content={label} side="top">
      <span className="inline-flex shrink-0">
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'flex h-cta aspect-square shrink-0 items-center justify-center rounded-full transition-colors',
            disabled
              ? 'cursor-not-allowed bg-panel text-low'
              : variant === 'primary'
                ? 'bg-brand text-on-brand hover:bg-brand-hover'
                : 'bg-panel text-normal hover:text-high'
          )}
        >
          {ActionIcon === 'spinner' ? (
            <SpinnerIcon className="size-icon-sm animate-spin" weight="bold" />
          ) : (
            <ActionIcon className="size-icon-sm" weight="bold" />
          )}
        </button>
      </span>
    </Tooltip>
  );
}
