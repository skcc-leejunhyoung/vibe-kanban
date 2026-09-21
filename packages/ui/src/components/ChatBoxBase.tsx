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

      {/* Banner content (queued indicator, feedback mode, etc.) */}
      {banner}

      {/* Header - stats (left) and session controls (right), no divider */}
      {visualVariant === VisualVariant.NORMAL && (
        <div className="flex items-center gap-base px-plusfifty pt-base">
          <div className="flex flex-1 items-center gap-base text-sm min-w-0 overflow-hidden">
            {headerLeft}
          </div>
          <Toolbar className="shrink-0">{headerRight}</Toolbar>
        </div>
      )}

      {/* Editor area */}
      <div
        className={cn(
          'flex flex-col gap-base px-plusfifty py-base',
          fillHeight && 'min-h-0 flex-1'
        )}
      >
        {editor}

        {/* Footer - one row when it fits: attach/model controls on the left,
            round action buttons on the right. The left group keeps its natural
            width (flex-auto) so on narrow widths the action buttons drop to
            their own line instead of squeezing the controls into a sliver. */}
        <div
          className={cn(
            'flex flex-wrap items-end justify-between gap-base',
            fillHeight && 'shrink-0'
          )}
        >
          <Toolbar className="flex-auto min-w-0 flex-wrap !gap-half">
            {footerLeft}
            {modelSelector}
          </Toolbar>
          <div className="ml-auto flex shrink-0 items-center gap-half">
            {footerRight}
          </div>
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
