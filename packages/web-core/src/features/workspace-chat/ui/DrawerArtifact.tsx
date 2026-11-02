import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { withDisplayTimeZone } from '@vibe/ui/lib/datetime';
import { drawerArtifactsApi } from '@/shared/lib/api';
import type {
  ArtifactInputBridge,
  ArtifactViewState,
} from '@/shared/lib/artifactInputBridge';
import { buildArtifactPreview } from './artifact-preview';

export function DrawerArtifact({
  id,
  noteId,
  hostId,
  archived,
}: {
  id: string;
  noteId: string;
  hostId: string | null;
  archived: boolean;
}) {
  const { t } = useTranslation('common');
  const client = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const focusTarget = useRef<HTMLSpanElement>(null);
  const [height, setHeight] = useState(1);
  const [scriptError, setScriptError] = useState<string>();
  const bridge = useMemo<ArtifactInputBridge>(
    () => ({
      channel: `${hostId ?? 'local'}:${noteId}:${id}:${crypto.randomUUID()}`,
      actions: [],
      initial: { status: 'loading', message: '', editable: false },
    }),
    [id, noteId, hostId]
  );
  const document = useQuery({
    queryKey: ['drawer-artifact-document', hostId, noteId, id],
    queryFn: ({ signal }) =>
      drawerArtifactsApi.document(id, noteId, hostId, signal),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const snapshot = useQuery({
    queryKey: [
      'drawer-artifact-data',
      hostId,
      noteId,
      id,
      document.data?.version,
    ],
    queryFn: ({ signal }) =>
      drawerArtifactsApi.snapshot(
        id,
        noteId,
        document.data!.version,
        hostId,
        signal
      ),
    enabled: !!document.data && !archived,
    retry: false,
    gcTime: 0,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    // A failed poll backs off instead of stopping, so a blip doesn't freeze it.
    refetchInterval: (query) =>
      archived ? false : query.state.error ? 10000 : 2000,
  });
  useEffect(() => {
    if (archived)
      void client.cancelQueries({
        queryKey: ['drawer-artifact-data', hostId, noteId, id],
        exact: false,
      });
  }, [archived, client, hostId, noteId, id]);
  const preview = useMemo(() => {
    if (!document.data) return null;
    const value = document.data;
    if (value.note_id !== noteId)
      return { error: 'artifacts.drawer.unavailable' };
    const source = value.files.find((file) => file.path === value.path);
    if (!source) return { error: 'artifacts.drawer.unavailable' };
    try {
      return buildArtifactPreview(
        new TextDecoder().decode(Uint8Array.from(source.bytes)),
        value.path,
        value.files.map((file) => ({
          ...file,
          bytes: Uint8Array.from(file.bytes),
        })),
        false,
        bridge
      );
    } catch (cause) {
      return {
        error:
          cause instanceof Error
            ? cause.message
            : 'artifacts.drawer.unavailable',
      };
    }
  }, [document.data, noteId, bridge]);
  const state = useRef<ArtifactViewState>({
    status: 'loading',
    message: '',
    editable: false,
  });
  state.current = {
    status: archived
      ? 'paused'
      : snapshot.isError
        ? 'disconnected'
        : snapshot.data
          ? 'ready'
          : 'loading',
    message: archived
      ? t('artifacts.drawer.paused')
      : snapshot.isError
        ? t('artifacts.input.disconnected')
        : snapshot.data?.updated_at
          ? t('artifacts.drawer.updated', {
              time: new Date(snapshot.data.updated_at).toLocaleTimeString(
                undefined,
                withDisplayTimeZone()
              ),
            })
          : t('artifacts.drawer.waiting'),
    editable: false,
    data: snapshot.data?.data ?? null,
    revision: snapshot.data?.revision ?? 0,
    updatedAt: snapshot.data?.updated_at,
  };
  const postState = useCallback(
    () =>
      frame.current?.contentWindow?.postMessage(
        {
          type: 'vibe:artifact:state',
          channel: bridge.channel,
          value: state.current,
        },
        '*'
      ),
    [bridge.channel]
  );
  useEffect(() => {
    postState();
  }, [snapshot.data, snapshot.isError, archived, postState]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (
        event.data?.type === 'vibe:artifact:resize' &&
        Number.isFinite(event.data.height)
      )
        setHeight(Math.max(1, Math.min(10000, Math.ceil(event.data.height))));
      else if (
        event.data?.type === 'vibe:artifact:focus' &&
        Number.isFinite(event.data.top) &&
        Number.isFinite(event.data.bottom) &&
        event.data.top >= 0 &&
        event.data.bottom >= event.data.top &&
        event.data.bottom <= frame.current!.clientHeight &&
        focusTarget.current
      ) {
        focusTarget.current.style.top = `${event.data.top}px`;
        focusTarget.current.style.height = `${Math.max(1, event.data.bottom - event.data.top)}px`;
        focusTarget.current.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
        });
        focusTarget.current.style.top = '0';
        focusTarget.current.style.height = '0';
      } else if (
        event.data?.type === 'vibe:artifact:input' &&
        event.data.channel === bridge.channel &&
        event.data.event === 'ready'
      )
        postState();
      else if (
        event.data?.type === 'vibe:artifact:error' &&
        typeof event.data.message === 'string'
      )
        setScriptError(event.data.message.slice(0, 500));
      // No submission, draft or action messages are accepted by this read-only view.
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [bridge.channel, postState]);
  const failure =
    document.error?.message ??
    (preview && 'error' in preview
      ? preview.error === 'artifacts.drawer.unavailable'
        ? t('artifacts.drawer.unavailable')
        : preview.error
      : undefined);
  if (failure)
    return (
      <div>
        <p role="alert">{failure}</p>
        {document.isError && (
          <button
            type="button"
            className="rounded-sm bg-secondary px-base py-half"
            onClick={() => void document.refetch()}
          >
            {t('artifacts.input.check')}
          </button>
        )}
      </div>
    );
  if (!preview || !('srcDoc' in preview))
    return <p role="status">{t('artifacts.loading')}</p>;
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
          title={document.data!.name}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          scrolling="no"
          srcDoc={preview.srcDoc}
          className="w-full border-0 bg-white"
          style={{ height }}
          onLoad={postState}
        />
      </div>
      <figcaption
        className="px-base py-half text-sm text-low"
        aria-live="polite"
      >
        <p>{state.current.message}</p>
        {/* The bridge reports any failed resource, so keep the frame. */}
        {scriptError && <p role="alert">{scriptError}</p>}
        {!archived && snapshot.isError && (
          <button
            type="button"
            className="rounded-sm bg-secondary px-base py-half"
            onClick={() => void snapshot.refetch()}
          >
            {t('artifacts.input.check')}
          </button>
        )}
      </figcaption>
    </figure>
  );
}
