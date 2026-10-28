import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactInteraction, ArtifactResponse } from 'shared/types';
import { ApiError, artifactsApi } from '@/shared/lib/api';
import type { ArtifactViewState } from '@/shared/lib/artifactInputBridge';

// Native form drafts only, scoped to this page and request. No browser storage,
// backend writes, or model messages on input. Virtualized rows may unmount.
const views = new Map<
  string,
  { draft?: unknown; pending?: ArtifactResponse }
>();

export function ArtifactInputFrame({
  srcDoc,
  channel,
  interaction,
  hostId,
  title,
  refresh,
  updated,
  disconnected,
}: {
  srcDoc: string;
  channel: string;
  interaction: ArtifactInteraction;
  hostId: string | null;
  title: string;
  refresh: () => Promise<void>;
  updated: (interaction: ArtifactInteraction) => void;
  disconnected: boolean;
}) {
  const { t } = useTranslation('common');
  const key = `${hostId ?? 'local'}:${interaction.workspace_id}:${interaction.reference.session_id}:${interaction.reference.request_id}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(!!views.get(key)?.pending);
  const [expanded, setExpanded] = useState(false);
  const view: ArtifactViewState = {
    status: sending
      ? 'sending'
      : disconnected || uncertain
        ? 'disconnected'
        : interaction.state,
    message:
      error ??
      (disconnected || uncertain
        ? t('artifacts.input.disconnected')
        : (interaction.error ??
          t(`artifacts.input.${sending ? 'sending' : interaction.state}`))),
    editable:
      !sending &&
      !disconnected &&
      !uncertain &&
      interaction.state === 'input_required',
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
          ...(restore ? { draft: views.get(key)?.draft } : {}),
        },
        '*'
      ),
    [channel, key]
  );

  useEffect(() => {
    postState();
  }, [postState, view.status, view.message, view.editable]);

  const submit = async (response: ArtifactResponse) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError(undefined);
    const saved = views.get(key) ?? {};
    views.set(key, { ...saved, pending: response });
    try {
      const result = await artifactsApi.respond(interaction, response, hostId);
      views.set(key, { draft: saved.draft });
      setUncertain(false);
      updated(result);
    } catch (cause) {
      const rejected =
        cause instanceof ApiError &&
        [400, 403, 409, 422].includes(cause.status ?? 0);
      setUncertain(!rejected);
      if (rejected) views.set(key, { draft: saved.draft });
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
  const handlers = useRef({ submit, refresh });
  handlers.current = { submit, refresh };
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data === 'vibe:artifact:escape') {
        setExpanded(false);
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
        case 'ready':
          postState(true);
          break;
        case 'draft':
          if (JSON.stringify(event.data.data).length <= 32768) {
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
  }, [channel, key, postState]);

  const check = async () => {
    try {
      await handlers.current.refresh();
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
      <div>
        <div className="flex items-center gap-base border-b border-border p-base">
          <span className="min-w-0 flex-1 truncate font-medium text-high">
            {title}
          </span>
          <button
            type="button"
            className="rounded-sm px-base py-half text-normal hover:bg-secondary"
            onClick={() => setExpanded(!expanded)}
          >
            {t(expanded ? 'artifacts.input.collapse' : 'artifacts.expand')}
          </button>
        </div>
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className={
            expanded
              ? 'h-[75vh] w-full border-0 bg-white'
              : 'h-[420px] w-full border-0 bg-white'
          }
        />
        <figcaption className="space-y-half border-t border-border p-base">
          <p role={error || disconnected ? 'alert' : 'status'}>
            {view.message}
          </p>
          {interaction.state === 'input_required' && (
            <p className="text-low">{t('artifacts.input.noDraftStorage')}</p>
          )}
          {(disconnected ||
            uncertain ||
            error ||
            interaction.state === 'unknown' ||
            interaction.state === 'failed') && (
            <div className="flex gap-base">
              <button
                type="button"
                className="rounded-sm bg-secondary px-base py-half"
                disabled={sending}
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
            </div>
          )}
        </figcaption>
      </div>
    </figure>
  );
}
