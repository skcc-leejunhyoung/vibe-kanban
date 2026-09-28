import {
  type KeyboardEventHandler,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
} from 'react';
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

// The most a banner is guaranteed in a height-capped box. The box is at most
// half the column (≈ 50svh - chrome); this leaves the header, the footer and
// 3-4 lines of input (more on taller viewports) beside it, so the buttons
// never leave the box. The reserve is in rem so it grows with the UI size
// like the header and footer do. No fixed minimum: on a short viewport
// (phone landscape) any floor the box can't fit pushes the footer out of it,
// so there the banner shrinks and scrolls like the input.
const BANNER_FLOOR = 'max(0px, 40svh - 9.375rem)';

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
  const bannerRef = useRef<HTMLDivElement>(null);
  const bannerContentRef = useRef<HTMLDivElement>(null);

  // Give the banner a floor of its own natural height, capped by
  // BANNER_FLOOR. Flex would otherwise shave every region by the same
  // fraction, squeezing a one-line queue or a short question into a scrolling
  // sliver whenever the prompt below is long. Above the floor the banner
  // shares the squeeze with the input in proportion to their sizes, so a long
  // question takes whatever the input doesn't need (an empty input leaves it
  // almost the whole box) and still yields down to the floor when the prompt
  // is long too. CSS can't express "min(natural, cap)", so the natural height
  // is measured off the inner content wrapper: unlike the scroll container's
  // scrollHeight, which never reads below the box's own height and would
  // leave the floor inflated after the content shrinks, the wrapper is the
  // content. Observing it catches every change that matters, including a
  // narrower box wrapping the text taller without a render. Writing the same
  // value again is a no-op, so the observer settles immediately.
  const applyBannerFloor = useCallback(() => {
    const el = bannerRef.current;
    const content = bannerContentRef.current;
    if (!el || !content) return;
    // Add the border: the floor is a border-box size, and a floor that's
    // short by the border would leave a 1px scroll.
    const natural =
      content.getBoundingClientRect().height +
      (el.offsetHeight - el.clientHeight);
    el.style.minHeight = `min(${natural}px, ${BANNER_FLOOR})`;
  }, []);
  const hasBanner = Boolean(banner);
  useLayoutEffect(() => {
    const content = bannerContentRef.current;
    if (!fillHeight || !hasBanner || !content) return;
    applyBannerFloor();
    const observer = new ResizeObserver(applyBannerFloor);
    observer.observe(content);
    return () => observer.disconnect();
  }, [fillHeight, hasBanner, applyBannerFloor]);

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
          height-capped box it shrinks and scrolls, but never below the floor
          set in applyBannerFloor (min-h-0 only holds until that runs, before
          first paint). The divider lives on the scroll wrapper (each banner's
          own bottom border is dropped on the last one) so it stays put while
          the banners scroll; the `:has` rule hides the whole thing when the
          banner renders nothing (e.g. an answered question awaiting the
          agent). */}
      {banner && (
        <div
          ref={bannerRef}
          className={cn(
            'border-b [&:has(>:empty)]:hidden',
            fillHeight && 'min-h-0 overflow-y-auto'
          )}
        >
          <div ref={bannerContentRef} className="[&>*:last-child]:border-b-0">
            {banner}
          </div>
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

      {/* Editor area. `flex-auto` (basis = content) shares the squeeze with
          the banner in proportion to their sizes and scrolls internally. The
          floor keeps one line of input visible even when the box is too short
          for the banner's floor. The floor is exactly
          `pt-base` + one `text-base` line (1.5rem, scaled by the text size
          preference like the font token), so a one-line box is never taller
          than its content. The footer is deliberately NOT inside this element:
          when it was, squeezing the editor area squeezed the action buttons
          out of the box with it. */}
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
