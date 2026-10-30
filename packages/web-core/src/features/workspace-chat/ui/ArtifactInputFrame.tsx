import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactInteraction, ArtifactResponse } from 'shared/types';
import { ApiError, artifactsApi } from '@/shared/lib/api';
import type { ArtifactViewState } from '@/shared/lib/artifactInputBridge';
import { useArtifactAutomation } from './useArtifactAutomation';
import {
  artifactDrafts as views,
  artifactMemoryKey,
} from '@/shared/lib/artifactInputMemory';

// Native form drafts only, scoped to this page and request. No browser storage,
// backend writes, or model messages on input. Virtualized rows may unmount.

export function ArtifactInputFrame({
  srcDoc,
  channel,
  interaction,
  hostId,
  title,
  refresh,
  updated,
  disconnected,
  readOnly = false,
}: {
  srcDoc: string;
  channel: string;
  interaction: ArtifactInteraction;
  hostId: string | null;
  title: string;
  refresh: () => Promise<void>;
  updated: (interaction: ArtifactInteraction) => void;
  disconnected: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation('common');
  const key = artifactMemoryKey(interaction, hostId);
  const frame = useRef<HTMLIFrameElement>(null);
  const focusTarget = useRef<HTMLSpanElement>(null);
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(
    !readOnly && !!views.get(key)?.pending
  );
  const [height, setHeight] = useState(1);
  const automation = useArtifactAutomation(interaction, hostId, readOnly);
  const live = !!interaction.automation;
  const displayError = error ?? (live ? automation.error : undefined);
  const displayStatus =
    readOnly && interaction.state === 'input_required'
      ? 'expired'
      : live && interaction.state === 'input_required'
        ? (automation.current?.status ?? interaction.state)
        : interaction.state;
  const messageStatus =
    sending || (live && automation.sending)
      ? 'sending'
      : live && displayStatus === 'input_required'
        ? 'automationReady'
        : displayStatus;
  const view: ArtifactViewState = {
    status:
      sending || (live && automation.sending)
        ? 'sending'
        : disconnected || uncertain || (live && automation.uncertain)
          ? 'disconnected'
          : displayStatus,
    message:
      readOnly && interaction.state === 'input_required'
        ? t('artifacts.input.expired')
        : (displayError ??
          (disconnected || uncertain || (live && automation.uncertain)
            ? t('artifacts.input.disconnected')
            : ((live && interaction.state === 'input_required'
                ? automation.current?.message
                : undefined) ??
              interaction.error ??
              t(`artifacts.input.${messageStatus}`)))),
    editable:
      !readOnly &&
      !sending &&
      !disconnected &&
      !uncertain &&
      interaction.state === 'input_required' &&
      (!live || automation.editable),
    ...(live
      ? {
          data: automation.snapshot?.data,
          revision: automation.snapshot?.revision,
          updatedAt: automation.snapshot?.updated_at,
          request: automation.current,
        }
      : {}),
  };
  const state = useRef(view);
  state.current = view;
  const postState = useCallback(
    (restore = false) =>
      frame.current?.contentWindow?.postMessage(
        {
          type: 'vibe:artifact:state',
          channel,
          value: state.current,
          ...(restore && !readOnly ? { draft: views.get(key)?.draft } : {}),
        },
        '*'
      ),
    [channel, key, readOnly]
  );

  useEffect(() => {
    postState();
  }, [
    postState,
    view.status,
    view.message,
    view.editable,
    view.data,
    view.revision,
    view.updatedAt,
    view.request,
  ]);

  const submit = async (response: ArtifactResponse) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError(undefined);
    const saved = views.get(key) ?? {};
    const pendingEntry = { ...saved, pending: response };
    views.set(key, pendingEntry);
    try {
      const result = await artifactsApi.respond(interaction, response, hostId);
      if (views.get(key) === pendingEntry)
        views.set(key, { draft: saved.draft });
      setUncertain(false);
      updated(result);
    } catch (cause) {
      const rejected =
        cause instanceof ApiError &&
        [400, 403, 409, 422].includes(cause.status ?? 0);
      setUncertain(!rejected);
      if (rejected && views.get(key) === pendingEntry)
        views.set(key, { draft: saved.draft });
      setError(
        rejected && cause instanceof Error
          ? cause.message
          : t('artifacts.input.disconnected')
      );
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  const handlers = useRef({ submit, refresh, request: automation.request });
  handlers.current = { submit, refresh, request: automation.request };
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (
        event.data?.type === 'vibe:artifact:resize' &&
        Number.isFinite(event.data.height)
      ) {
        setHeight(Math.max(1, Math.min(10000, Math.ceil(event.data.height))));
        return;
      }
      if (
        event.data?.type === 'vibe:artifact:focus' &&
        Number.isFinite(event.data.top) &&
        Number.isFinite(event.data.bottom) &&
        event.data.top >= 0 &&
        event.data.bottom >= event.data.top &&
        event.data.bottom <= frame.current!.clientHeight &&
        focusTarget.current
      ) {
        // A local anchor reveals keyboard focus across both sandbox boundaries.
        focusTarget.current.style.top = `${event.data.top}px`;
        focusTarget.current.style.height = `${event.data.bottom - event.data.top}px`;
        focusTarget.current.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
        });
        focusTarget.current.style.top = '0';
        focusTarget.current.style.height = '0';
        return;
      }
      if (
        event.data?.type === 'vibe:artifact:error' &&
        typeof event.data.message === 'string'
      ) {
        setError(event.data.message.slice(0, 500));
        return;
      }
      if (
        event.data?.type !== 'vibe:artifact:input' ||
        event.data.channel !== channel
      )
        return;
      switch (event.data.event) {
        case 'request':
          if (
            state.current.editable &&
            typeof event.data.data?.action === 'string'
          )
            handlers.current.request(
              event.data.data.action,
              event.data.data.data
            );
          break;
        case 'ready':
          postState(true);
          break;
        case 'draft':
          if (!readOnly && JSON.stringify(event.data.data).length <= 32768) {
            if (!views.has(key) && views.size >= 128)
              views.delete(views.keys().next().value!);
            views.set(key, { ...views.get(key), draft: event.data.data });
          }
          break;
        case 'submit':
          if (state.current.editable)
            void handlers.current.submit({
              action: 'submit',
              data: event.data.data,
            });
          break;
        case 'cancel':
          if (state.current.editable)
            void handlers.current.submit({ action: 'cancel' });
          break;
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [channel, key, postState, readOnly]);

  const check = async () => {
    try {
      await handlers.current.refresh();
      if (live) await automation.check();
      setError(undefined);
      setUncertain(false);
      const saved = views.get(key);
      if (saved) views.set(key, { draft: saved.draft });
    } catch {
      setError(t('artifacts.input.disconnected'));
    }
  };
  return (
    <figure className="my-half rounded-sm border border-border bg-panel text-base">
      <div className="relative">
        <span
          ref={focusTarget}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 w-px opacity-0"
        />
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          scrolling="no"
          srcDoc={srcDoc}
          className="w-full border-0 bg-white"
          style={{ height }}
        />
        <figcaption className="space-y-half border-t border-border p-base">
          {interaction.automation && (
            <p className="text-normal">
              {t('artifacts.input.automationActions', {
                actions: Object.values(interaction.automation.actions)
                  .map((action) => action?.label)
                  .filter(Boolean)
                  .join(', '),
              })}
            </p>
          )}
          {interaction.handler === 'session.rename' && (
            <p className="text-normal">{t('artifacts.input.renameSession')}</p>
          )}
          <p role={displayError || disconnected ? 'alert' : 'status'}>
            {view.message}
          </p>
          {interaction.state === 'failed' && (
            <p className="text-low">{t('artifacts.input.failedRecovery')}</p>
          )}
          {!readOnly && interaction.state === 'input_required' && (
            <p className="text-low">{t('artifacts.input.noDraftStorage')}</p>
          )}
          {!readOnly &&
            live &&
            !view.editable &&
            interaction.state === 'input_required' && (
              <button
                type="button"
                className="rounded-sm bg-secondary px-base py-half"
                disabled={sending}
                onClick={() => void submit({ action: 'cancel' })}
              >
                {t('artifacts.input.automationClose')}
              </button>
            )}
          {!readOnly &&
            (disconnected ||
              uncertain ||
              displayError ||
              (live &&
                (automation.uncertain ||
                  automation.current?.status === 'unknown')) ||
              interaction.state === 'unknown' ||
              interaction.state === 'failed') && (
              <div className="flex gap-base">
                <button
                  type="button"
                  className="rounded-sm bg-secondary px-base py-half"
                  disabled={sending || automation.sending}
                  onClick={() => void check()}
                >
                  {t('artifacts.input.check')}
                </button>
                {views.get(key)?.pending && (
                  <button
                    type="button"
                    className="rounded-sm bg-secondary px-base py-half"
                    disabled={sending}
                    onClick={() => void submit(views.get(key)!.pending!)}
                  >
                    {t('artifacts.input.retry')}
                  </button>
                )}
                {live && automation.retry && (
                  <button
                    type="button"
                    className="rounded-sm bg-secondary px-base py-half"
                    disabled={automation.sending}
                    onClick={() => void automation.retry?.()}
                  >
                    {t('artifacts.input.retry')}
                  </button>
                )}
              </div>
            )}
        </figcaption>
      </div>
    </figure>
  );
}
