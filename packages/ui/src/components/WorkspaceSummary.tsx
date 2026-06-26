import {
  PushPinIcon,
  HandIcon,
  TriangleIcon,
  PlayIcon,
  FileIcon,
  CircleIcon,
  GitPullRequestIcon,
  DotsThreeIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { Ref } from 'react';
import { cn } from '../lib/cn';
import { RunningDots } from './RunningDots';

const formatRelativeElapsed = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

/** Coarse activity status used for the color-coded issue-card display. */
export type WorkspaceActivityStatus = 'running' | 'attention' | 'idle';

export function getWorkspaceActivityStatus(ws: {
  isRunning?: boolean;
  hasPendingApproval?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
}): WorkspaceActivityStatus {
  const isFailed =
    ws.latestProcessStatus === 'failed' || ws.latestProcessStatus === 'killed';
  // Needs attention: waiting on the user (a tool approval), or finished with
  // something unseen/failed while not actively running.
  const needsAttention =
    ws.hasPendingApproval ||
    (!ws.isRunning && (ws.hasUnseenActivity || isFailed));
  if (needsAttention) return 'attention';
  if (ws.isRunning) return 'running';
  return 'idle';
}

/**
 * Raw HSL triple CSS variable for each status accent (null for idle). Applied
 * via inline style so it works in every app regardless of whether the Tailwind
 * `warning` color is registered (remote-web has no theme config).
 */
const STATUS_ACCENT_VAR: Record<WorkspaceActivityStatus, string | null> = {
  running: 'var(--brand)',
  attention: 'var(--warning)',
  idle: null,
};

export interface WorkspaceSummaryProps {
  name: string;
  workspaceId?: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isActive?: boolean;
  isRunning?: boolean;
  isPinned?: boolean;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessCompletedAt?: string;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  onClick?: () => void;
  className?: string;
  summary?: boolean;
  /** Whether this is a draft workspace (shows "Draft" instead of elapsed time) */
  isDraft?: boolean;
  onOpenWorkspaceActions?: (workspaceId: string) => void;
  /** Keyboard navigation cursor is on this row (arrow/vim key focus) */
  isFocused?: boolean;
  /** Ref to the row container, used to scroll the focused row into view */
  forwardedRef?: Ref<HTMLDivElement>;
  /** Most recent prompt — preferred over name when emphasizeStatus is set */
  latestPrompt?: string;
  /**
   * Issue-card mode: replace the animated running dots with an explicit,
   * color-coded status (running / attention / idle) and prefer the latest
   * prompt over the workspace name (which often duplicates the issue title).
   */
  emphasizeStatus?: boolean;
}

export function WorkspaceSummary({
  name,
  workspaceId,
  filesChanged,
  linesAdded,
  linesRemoved,
  isActive = false,
  isRunning = false,
  isPinned = false,
  hasPendingApproval = false,
  hasRunningDevServer = false,
  hasUnseenActivity = false,
  latestProcessCompletedAt,
  latestProcessStatus,
  prStatus,
  onClick,
  className,
  summary = false,
  isDraft = false,
  onOpenWorkspaceActions,
  isFocused = false,
  forwardedRef,
  latestPrompt,
  emphasizeStatus = false,
}: WorkspaceSummaryProps) {
  const { t } = useTranslation('common');
  const hasChanges = filesChanged !== undefined && filesChanged > 0;
  const isFailed =
    latestProcessStatus === 'failed' || latestProcessStatus === 'killed';

  // Color-coded status for the issue-card display. accentVar is the raw HSL
  // triple ("25 82% 54%") applied via inline style; null when idle (no accent).
  const activityStatus = getWorkspaceActivityStatus({
    isRunning,
    hasPendingApproval,
    hasUnseenActivity,
    latestProcessStatus,
  });
  const accentVar = emphasizeStatus ? STATUS_ACCENT_VAR[activityStatus] : null;
  // Prefer the latest prompt over the name in issue-card mode (the name often
  // just repeats the issue title shown on the card header).
  const primaryText =
    emphasizeStatus && latestPrompt?.trim() ? latestPrompt.trim() : name;
  // Left tab color: status accent in issue-card mode, falling back to the brand
  // selection color when an idle row is active.
  const barAccentVar = emphasizeStatus
    ? (accentVar ?? (isActive ? 'var(--brand)' : null))
    : null;

  const handleOpenCommandBar = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!workspaceId || !onOpenWorkspaceActions) return;
    onOpenWorkspaceActions(workspaceId);
  };

  return (
    <div
      ref={forwardedRef}
      // tabIndex=-1 makes the row programmatically focusable so keyboard
      // navigation can move real DOM focus here (keeping the sidebar's hotkey
      // scope active and letting native Enter agree with the cursor). It stays
      // out of the Tab order — the inner button is the tab stop. outline-none
      // hides the native focus ring in favor of the isFocused brand ring.
      tabIndex={-1}
      className={cn(
        'group relative rounded-sm transition-all duration-100 overflow-hidden outline-none',
        isActive ? 'bg-tertiary' : '',
        isFocused && 'ring-1 ring-inset ring-brand',
        className
      )}
      // Issue-card mode: tint the whole row with the status color (attention a
      // touch stronger than running) so its state reads without parsing icons.
      style={
        emphasizeStatus && !isActive && accentVar
          ? {
              backgroundColor: `hsl(${accentVar} / ${
                activityStatus === 'attention' ? 0.1 : 0.05
              })`,
            }
          : undefined
      }
    >
      {/* Left tab: selection indicator, or color-coded status in issue-card mode */}
      <div
        className={cn(
          'absolute left-0 top-1 bottom-1 rounded-full transition-colors duration-100',
          emphasizeStatus ? 'w-1' : 'w-0.5',
          !emphasizeStatus && (isActive ? 'bg-brand' : 'bg-transparent')
        )}
        style={
          barAccentVar ? { backgroundColor: `hsl(${barAccentVar})` } : undefined
        }
      />
      <button
        onClick={onClick}
        className={cn(
          'flex w-full cursor-pointer flex-col text-left px-base py-half transition-all duration-150',
          isActive
            ? 'text-normal'
            : 'text-low sm:opacity-60 sm:hover:opacity-100 sm:hover:text-normal'
        )}
      >
        <div
          className={cn(
            'overflow-hidden whitespace-nowrap pr-double',
            !summary && 'text-normal'
          )}
          style={{
            maskImage:
              'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
          }}
        >
          {primaryText}
        </div>
        {(!summary || isActive) && (
          <div className="flex w-full items-center gap-base text-sm h-5">
            {/* Dev server running - leftmost */}
            {hasRunningDevServer && (
              <PlayIcon
                className="size-icon-xs text-brand shrink-0"
                weight="fill"
              />
            )}

            {emphasizeStatus ? (
              /* Issue-card mode: a single explicit, color-coded status marker
                 (no animation) so running / attention / idle read at a glance.
                 Pending approval keeps the hand icon (in the attention color). */
              hasPendingApproval ? (
                <HandIcon
                  className="size-icon-xs shrink-0"
                  weight="fill"
                  style={{ color: 'hsl(var(--warning))' }}
                />
              ) : accentVar ? (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: `hsl(${accentVar})` }}
                  aria-hidden="true"
                />
              ) : null
            ) : (
              <>
                {/* Failed/killed status (only when not running) */}
                {!isRunning && isFailed && (
                  <TriangleIcon
                    className="size-icon-xs text-error shrink-0"
                    weight="fill"
                  />
                )}

                {/* Running dots OR hand icon for pending approval */}
                {isRunning &&
                  (hasPendingApproval ? (
                    <HandIcon
                      className="size-icon-xs text-brand shrink-0"
                      weight="fill"
                    />
                  ) : (
                    <RunningDots />
                  ))}

                {/* Unseen activity indicator (only when not running and not failed) */}
                {hasUnseenActivity && !isRunning && !isFailed && (
                  <CircleIcon
                    className="size-icon-xs text-brand shrink-0"
                    weight="fill"
                  />
                )}
              </>
            )}

            {/* PR status icon */}
            {prStatus === 'open' && (
              <GitPullRequestIcon
                className="size-icon-xs text-success shrink-0"
                weight="fill"
              />
            )}
            {prStatus === 'merged' && (
              <GitPullRequestIcon
                className="size-icon-xs text-merged shrink-0"
                weight="fill"
              />
            )}

            {/* Pin icon */}
            {isPinned && (
              <PushPinIcon
                className="size-icon-xs text-brand shrink-0"
                weight="fill"
              />
            )}

            {/* Time elapsed OR "Draft" label (when not running) */}
            {!isRunning &&
              (isDraft ? (
                <span className="min-w-0 flex-1 truncate">
                  {t('workspaces.draft')}
                </span>
              ) : latestProcessCompletedAt ? (
                <span className="min-w-0 flex-1 truncate">
                  {formatRelativeElapsed(latestProcessCompletedAt)}
                </span>
              ) : (
                <span className="flex-1" />
              ))}

            {/* Spacer when running (no elapsed time shown) */}
            {isRunning && <span className="flex-1" />}

            {/* File count + lines changed on the right */}
            {hasChanges && (
              <span className="shrink-0 text-right flex items-center gap-half">
                <FileIcon className="size-icon-xs" weight="fill" />
                <span>{filesChanged}</span>
                {linesAdded !== undefined && (
                  <span className="text-success">+{linesAdded}</span>
                )}
                {linesRemoved !== undefined && (
                  <span className="text-error">-{linesRemoved}</span>
                )}
              </span>
            )}
          </div>
        )}
      </button>

      {/* Right-side hover action - more options only */}
      {workspaceId && onOpenWorkspaceActions && (
        <div className="absolute right-0 top-0 bottom-0 flex items-center sm:opacity-0 sm:group-hover:opacity-100">
          {/* Gradient fade from transparent to background */}
          <div className="h-full w-6 pointer-events-none bg-gradient-to-r from-transparent to-secondary" />
          {/* Single action button */}
          <div className="flex items-center pr-base h-full bg-secondary">
            <button
              onClick={handleOpenCommandBar}
              onPointerDown={(e) => e.stopPropagation()}
              className="p-1.5 rounded-sm text-low hover:text-normal hover:bg-tertiary"
              title={t('workspaces.more')}
            >
              <DotsThreeIcon className="size-5" weight="bold" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
