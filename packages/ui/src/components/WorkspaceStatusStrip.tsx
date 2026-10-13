import { useTranslation } from 'react-i18next';
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  HandIcon,
  TriangleIcon,
} from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { RunningDots } from './RunningDots';

export type StatusToken =
  | { kind: 'text'; text: string }
  | { kind: 'link'; label: string; target: string; artifact: boolean };

export type WorkspaceStatusState = 'running' | 'pending' | 'failed' | 'idle';

export interface WorkspaceStatusStripProps {
  /** Sentence shown while collapsed, in the sidebar and on issue cards. */
  headline: string;
  /** The full summary, one token list per paragraph. */
  paragraphs: StatusToken[][];
  /** Execution state of the workspace; the agent never writes this. */
  state: WorkspaceStatusState;
  /** The block is still streaming in. */
  streaming?: boolean;
  /** Viewing an earlier summary through the arrows. */
  isPast?: boolean;
  /** "2m ago" for the current summary, a clock time for an earlier one. */
  timeLabel: string;
  open: boolean;
  onToggle: () => void;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onOpenLink: (target: string, artifact: boolean) => void;
}

const STATE_BORDER: Record<WorkspaceStatusState, string> = {
  running: 'border-l-brand',
  pending: 'border-l-warning',
  failed: 'border-l-error',
  idle: 'border-l-low',
};

function StateIcon({ state }: { state: WorkspaceStatusState }) {
  if (state === 'running') return <RunningDots />;
  if (state === 'pending')
    return <HandIcon className="size-icon-xs text-warning" weight="fill" />;
  if (state === 'failed')
    return <TriangleIcon className="size-icon-xs text-error" weight="fill" />;
  return <span className="size-dot rounded-full bg-low" />;
}

/**
 * The live summary strip above a conversation: one line while collapsed, the
 * whole summary when open. Colour and icon follow the execution state; the
 * text is the agent's own words.
 */
export function WorkspaceStatusStrip({
  headline,
  paragraphs,
  state,
  streaming = false,
  isPast = false,
  timeLabel,
  open,
  onToggle,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onOpenLink,
}: WorkspaceStatusStripProps) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cn(
        'shrink-0 border-b border-l-2 bg-secondary',
        STATE_BORDER[state]
      )}
      data-workspace-status-strip
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? t('status.collapse') : t('status.expand')}
        className="flex w-full items-center gap-base px-base py-half text-left"
      >
        <span className="flex w-4 shrink-0 items-center justify-center">
          <StateIcon state={state} />
        </span>
        {!open && (
          <span
            className="min-w-0 flex-1 truncate text-sm text-high"
            aria-live="polite"
          >
            {headline}
          </span>
        )}
        {open && <span className="flex-1" />}
        <span className="shrink-0 text-xs text-low tabular-nums">
          {isPast ? `${t('status.past')} · ${timeLabel}` : timeLabel}
        </span>
        <CaretDownIcon
          className={cn(
            'size-icon-xs shrink-0 text-low transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <div className="border-t border-dashed px-base pb-half">
          <div
            className={cn(
              'max-h-[44vh] overflow-y-auto py-half text-sm',
              isPast ? 'text-low' : 'text-normal'
            )}
          >
            {paragraphs.map((tokens, index) => (
              <p
                key={index}
                className={cn(
                  'm-0 leading-relaxed',
                  index > 0 && 'mt-half border-t border-border/50 pt-half'
                )}
              >
                {tokens.map((token, tokenIndex) =>
                  token.kind === 'text' ? (
                    <span key={tokenIndex}>{token.text}</span>
                  ) : (
                    <button
                      key={tokenIndex}
                      type="button"
                      onClick={() => onOpenLink(token.target, token.artifact)}
                      className="inline text-high underline decoration-dotted decoration-brand/80 underline-offset-2 hover:text-brand"
                    >
                      {token.label}
                    </button>
                  )
                )}
                {streaming && index === paragraphs.length - 1 && (
                  <span className="ml-0.5 inline-block h-[1em] w-px animate-pulse bg-brand align-text-bottom" />
                )}
              </p>
            ))}
          </div>
          <div className="flex items-center justify-end gap-half">
            <button
              type="button"
              onClick={onPrev}
              disabled={!canPrev}
              aria-label={t('status.prev')}
              title={t('status.prev')}
              className="flex size-5 items-center justify-center rounded-sm text-low hover:bg-panel hover:text-normal disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <CaretLeftIcon className="size-icon-xs" />
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!canNext}
              aria-label={t('status.next')}
              title={t('status.next')}
              className="flex size-5 items-center justify-center rounded-sm text-low hover:bg-panel hover:text-normal disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <CaretRightIcon className="size-icon-xs" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The row an assistant message leaves where its summary block was. */
export function StatusNoteChip({
  headline,
  writing,
}: {
  headline: string;
  writing: boolean;
}) {
  const { t } = useTranslation('common');
  return (
    <div
      className={cn(
        'my-half inline-flex max-w-full items-center gap-base rounded-sm border border-l-2 bg-secondary px-base py-half text-xs',
        writing ? 'border-l-brand' : 'border-l-low'
      )}
    >
      {writing && <RunningDots />}
      <span className="shrink-0 font-medium text-low">
        {writing ? t('status.writing') : t('status.updated')}
      </span>
      {headline && (
        <span className="min-w-0 truncate text-normal">{headline}</span>
      )}
    </div>
  );
}
