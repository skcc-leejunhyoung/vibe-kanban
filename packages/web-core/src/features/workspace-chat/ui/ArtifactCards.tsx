import { useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create, useModal } from '@ebay/nice-modal-react';
import { useTranslation } from 'react-i18next';
import {
  ArrowSquareOutIcon,
  ArrowsOutSimpleIcon,
  BrowserIcon,
  DownloadSimpleIcon,
  EyeIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import { Download, Loader2, Share2 } from 'lucide-react';
import type { ArtifactReference } from 'shared/types';
import { ExecutionProcessStatus } from 'shared/types';
import { IconButton } from '@vibe/ui/components/IconButton';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { Switch } from '@vibe/ui/components/Switch';
import { Dialog } from '@vibe/ui/components/KeyboardDialog';
import { artifactsApi } from '@/shared/lib/api';
import { defineModal } from '@/shared/lib/modals';
import { canEmbedPdf } from '@/shared/lib/pdf-embed';
import { shareFile } from '@/shared/lib/share-file';
import { formatFileSize } from '@/shared/lib/utils';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { ExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { MermaidDiagram } from '@/shared/components/MermaidDiagram';
import { PdfPages } from '@/shared/components/PdfPages';
import { ImagePreviewDialog } from '@/shared/dialogs/wysiwyg/ImagePreviewDialog';
import { getResolvedTheme, useTheme } from '@/shared/hooks/useTheme';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import {
  buildArtifactPreview,
  deduplicateManagedImages,
  inlinePreviewKind,
  isOfficeMime,
  type InlinePreviewKind,
} from './artifact-preview';

type Scope = {
  processId: string;
  workspaceId: string;
  sessionId: string;
  hostId: string | null;
};

export function useExecutionArtifacts(
  processId: string,
  workspaceId: string,
  sessionId?: string,
  enabled = true
) {
  const hostId = useHostId();
  const processes = useContext(ExecutionProcessesContext);
  const running =
    processes?.executionProcessesAll.find((process) => process.id === processId)
      ?.status === ExecutionProcessStatus.running;
  const query = useQuery({
    queryKey: [
      'execution-artifacts',
      hostId,
      workspaceId,
      sessionId,
      processId,
    ],
    queryFn: ({ signal }) =>
      artifactsApi.list(processId, workspaceId, sessionId!, hostId, signal),
    enabled: enabled && !!sessionId && !!processId,
    staleTime: 1000,
    refetchInterval: (state) => (state.state.data?.complete ? false : 2000),
  });
  const { refetch } = query;
  useEffect(() => {
    if (enabled && !running && sessionId) void refetch();
  }, [enabled, running, sessionId, refetch]);
  return query;
}

type ArtifactContent = {
  blob: Blob;
  text: string;
  preview?: ReturnType<typeof buildArtifactPreview>;
  warnings: string[];
};

// Shared by the chat thumbnail and the dialog so opening costs no second fetch.
// `thumbnail` is the server-rendered first page of a PDF or Office document.
function useArtifactContent(
  artifact: ArtifactReference,
  scope: Scope,
  mode: 'thumbnail' | 'preview' | 'source'
) {
  const { t } = useTranslation('common');
  const { processId, workspaceId, sessionId, hostId } = scope;
  return useQuery({
    queryKey: [
      'artifact-content',
      hostId,
      workspaceId,
      sessionId,
      processId,
      artifact.id,
      artifact.content_hash,
      mode,
    ],
    retry: false,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }): Promise<ArtifactContent> => {
      // Snapshots are served as octet streams; object URLs need the real type.
      const fetchBytes = async (hash: string | undefined, mime: string) =>
        new Blob(
          [
            await artifactsApi.content(
              processId,
              workspaceId,
              sessionId,
              artifact.id,
              hostId,
              hash,
              signal
            ),
          ],
          { type: mime }
        );
      const fetchBundle = async () => {
        const bundle = await artifactsApi.bundle(
          processId,
          workspaceId,
          sessionId,
          artifact.id,
          hostId,
          signal
        );
        if (bundle.artifact.content_hash !== artifact.content_hash)
          throw new Error(t('artifacts.changed'));
        return bundle;
      };
      if (mode === 'thumbnail') {
        const bundle = await fetchBundle();
        const png = bundle.resources.find(
          (resource) => resource.mime === 'image/png'
        );
        if (!png)
          throw new Error(bundle.warnings.join(' ') || t('artifacts.binary'));
        return {
          blob: await fetchBytes(png.content_hash, 'image/png'),
          text: '',
          warnings: bundle.warnings,
        };
      }
      if (mode === 'preview' && isOfficeMime(artifact.mime)) {
        const bundle = await fetchBundle();
        const pdf = bundle.resources.find(
          (resource) => resource.mime === 'application/pdf'
        );
        if (!pdf)
          throw new Error(bundle.warnings.join(' ') || t('artifacts.binary'));
        return {
          blob: await fetchBytes(pdf.content_hash, 'application/pdf'),
          text: '',
          warnings: bundle.warnings,
        };
      }
      const blob = await fetchBytes(
        artifact.content_hash ?? undefined,
        artifact.mime
      );
      const textual =
        artifact.mime.startsWith('text/') ||
        artifact.mime === 'image/svg+xml' ||
        /\.(json|[cm]?js|[jt]sx?|vue|svelte|rs|py|sh|toml|ya?ml|xml)$/i.test(
          artifact.name
        );
      if (textual && blob.size > 2 * 1024 * 1024)
        throw new Error(t('artifacts.largeSource'));
      const text = textual ? await blob.text() : '';
      if (
        mode === 'preview' &&
        ['text/html', 'image/svg+xml'].includes(artifact.mime)
      ) {
        const bundle = await fetchBundle();
        const resources = await Promise.all(
          bundle.resources.map(async (resource) => ({
            ...resource,
            bytes: new Uint8Array(
              await (
                await fetchBytes(resource.content_hash, resource.mime)
              ).arrayBuffer()
            ),
          }))
        );
        const preview = buildArtifactPreview(
          text,
          bundle.base_path ?? artifact.path ?? artifact.name,
          resources,
          artifact.mime === 'image/svg+xml'
        );
        return { blob, text, preview, warnings: bundle.warnings };
      }
      return { blob, text, warnings: [] };
    },
  });
}

function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url;
}

function useArtifactActions(artifact: ArtifactReference, scope: Scope) {
  const [busy, setBusy] = useState<'download' | 'share'>();
  const [error, setError] = useState<string>();
  const run = async (action: 'download' | 'share') => {
    setBusy(action);
    setError(undefined);
    try {
      const blob = new Blob(
        [
          await artifactsApi.content(
            scope.processId,
            scope.workspaceId,
            scope.sessionId,
            artifact.id,
            scope.hostId,
            artifact.content_hash ?? undefined
          ),
        ],
        { type: artifact.mime }
      );
      const name = artifact.name.split('/').pop() ?? 'artifact';
      if (action === 'share' && (await shareFile(blob, name))) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      // Let the browser consume the click before releasing the download URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };
  return { run, busy, error };
}

// Fills the fullscreen dialog: title row, notes, content, then the action bar
// that mirrors the image viewer (metadata, source toggle, share, download).
function ArtifactViewer({
  artifact,
  scope,
  onClose,
}: {
  artifact: ArtifactReference;
  scope: Scope;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const { theme } = useTheme();
  const [showSource, setShowSource] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string>();
  const mode = showSource ? 'source' : 'preview';
  const kind = inlinePreviewKind(artifact);
  const isDocument = kind === 'pdf' || kind === 'office';
  const canToggleSource = [
    'text/html',
    'image/svg+xml',
    'text/vnd.mermaid',
    'text/markdown',
  ].includes(artifact.mime);
  const canShare = typeof navigator.share === 'function';
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data === 'vibe:artifact:escape') onClose();
      else if (
        event.data?.type === 'vibe:artifact:error' &&
        typeof event.data.message === 'string'
      )
        setRuntimeError(event.data.message.slice(0, 500));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onClose]);
  const { run, busy, error: actionError } = useArtifactActions(artifact, scope);
  const query = useArtifactContent(artifact, scope, mode);
  // WebKit stops an embedded PDF at page one, so those engines get the canvas
  // renderer instead of the browser's own viewer.
  const embedDocument = isDocument && canEmbedPdf();
  const documentUrl = useObjectUrl(
    embedDocument ? query.data?.blob : undefined
  );
  const warnings = [
    ...(query.data?.warnings ?? []),
    ...(query.data?.preview?.warnings ?? []),
    ...(query.data?.preview && mode === 'preview'
      ? [t('artifacts.staticPreview')]
      : []),
  ];
  const errors = [runtimeError, actionError].filter(
    (error): error is string => !!error
  );
  const renderContent = () => {
    if (query.isPending)
      return (
        <div role="status" className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-white/70" />
        </div>
      );
    if (query.error)
      return (
        <p role="alert" className="p-4">
          {query.error.message}
        </p>
      );
    const { text, preview } = query.data;
    if (mode === 'source')
      return (
        <pre className="h-full overflow-auto whitespace-pre-wrap bg-primary p-base font-ibm-plex-mono text-base text-normal">
          {text || t('artifacts.binary')}
        </pre>
      );
    if (preview)
      return (
        <iframe
          ref={frameRef}
          className="h-full w-full border-0 bg-white"
          title={artifact.name}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={preview.srcDoc}
        />
      );
    if (isDocument) {
      if (!embedDocument)
        return <PdfPages blob={query.data.blob} title={artifact.name} />;
      return documentUrl ? (
        <iframe
          className="h-full w-full border-0 bg-white"
          title={artifact.name}
          src={documentUrl}
        />
      ) : null;
    }
    if (artifact.mime === 'text/vnd.mermaid')
      return (
        <div className="h-full overflow-auto bg-primary text-normal">
          <MermaidDiagram
            chart={text}
            theme={getResolvedTheme(theme)}
            isolated
          />
        </div>
      );
    if (artifact.mime === 'text/markdown')
      return (
        <div className="h-full overflow-auto bg-primary p-base text-normal">
          <MarkdownPreview
            content={text}
            theme={getResolvedTheme(theme)}
            allowRemoteImages={false}
          />
        </div>
      );
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap bg-primary p-base font-ibm-plex-mono text-normal">
        {text || t('artifacts.binary')}
      </pre>
    );
  };
  const metadata = [artifact.mime, formatFileSize(BigInt(artifact.size_bytes))]
    .filter(Boolean)
    .join(' · ');
  const actionClassName = 'text-white/70 transition-colors hover:text-white';
  return (
    <>
      <p
        className="shrink-0 truncate px-4 pb-3 pr-16 pt-[max(1rem,env(safe-area-inset-top))] text-sm"
        title={artifact.name}
      >
        {artifact.name}
      </p>
      {warnings.map((warning) => (
        <p key={warning} className="shrink-0 px-4 pb-2 text-xs text-white/70">
          {warning}
        </p>
      ))}
      {errors.map((error) => (
        <p key={error} role="alert" className="shrink-0 px-4 pb-2 text-xs">
          {error}
        </p>
      ))}
      <div className="min-h-0 flex-1">{renderContent()}</div>
      <div className="flex shrink-0 items-center justify-between gap-4 bg-black/60 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 text-xs">
        <p className="truncate text-white/70">{metadata}</p>
        <div className="flex shrink-0 items-center gap-4">
          {canToggleSource && (
            <label className="flex items-center gap-half whitespace-nowrap text-white/70">
              {t('artifacts.source')}
              <Switch
                checked={showSource}
                onCheckedChange={setShowSource}
                aria-label={t('artifacts.source')}
              />
            </label>
          )}
          {canShare && (
            <button
              type="button"
              onClick={() => void run('share')}
              disabled={!!busy}
              className={actionClassName}
              aria-label={t('kanban.shareAttachment')}
              title={t('kanban.shareAttachment')}
            >
              {busy === 'share' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Share2 className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => void run('download')}
            disabled={!!busy}
            className={actionClassName}
            aria-label={t('artifacts.download')}
            title={t('artifacts.download')}
          >
            {busy === 'download' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </>
  );
}

type PreviewDialogProps = {
  artifact: ArtifactReference;
  scope: Scope;
};
// The existing global modal host keeps an open preview alive when its chat row
// moves or unmounts during virtualization. All requests retain the opening scope.
const ArtifactPreviewDialog = defineModal<PreviewDialogProps, void>(
  create<PreviewDialogProps>(({ artifact, scope }) => {
    const modal = useModal();
    const close = () => {
      modal.resolve();
      void modal.hide();
    };
    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        fullscreen
        aria-label={artifact.name}
      >
        {modal.visible && (
          <ArtifactViewer artifact={artifact} scope={scope} onClose={close} />
        )}
      </Dialog>
    );
  })
);

function ArtifactCard({
  artifact,
  scope,
  error,
}: {
  artifact: ArtifactReference;
  scope: Scope;
  error?: string;
}) {
  const { t } = useTranslation('common');
  const setPanel = useUiPreferencesStore(
    (state) => state.setRightMainPanelMode
  );
  const ready = !!artifact.content_hash && artifact.status !== 'preparing';
  const appSource = /\.(tsx|jsx|vue|svelte)$/i.test(artifact.name);
  return (
    <div className="my-half flex items-start gap-base rounded-sm border border-border bg-panel p-base text-base">
      <div className="min-w-0 flex-1">
        <p className="break-all font-medium text-high">{artifact.name}</p>
        <p className="text-low">
          {artifact.mime} · {t(`artifacts.status.${artifact.status}`)}
        </p>
        {artifact.source === 'workspace_observation' && (
          <p className="text-low">{t('artifacts.observed')}</p>
        )}
        {artifact.source_scope && (
          <p className="text-low">{t('artifacts.subagent')}</p>
        )}
        {artifact.error && (
          <p role="status" className="text-low">
            {artifact.error}
          </p>
        )}
        {appSource && <p className="text-low">{t('artifacts.appSource')}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-half">
        {artifact.url ? (
          <a
            href={artifact.url}
            onClick={(event) => {
              event.preventDefault();
              openExternalUrl(event.currentTarget.href);
            }}
            aria-label={t('artifacts.openOriginal')}
            title={t('artifacts.openOriginal')}
            className="flex items-center justify-center rounded-sm p-half text-low hover:bg-secondary/50 hover:text-normal"
          >
            <ArrowSquareOutIcon className="size-icon-sm" weight="bold" />
          </a>
        ) : (
          <>
            <IconButton
              icon={EyeIcon}
              aria-label={t('artifacts.preview')}
              title={t('artifacts.preview')}
              disabled={!ready}
              onClick={() =>
                void ArtifactPreviewDialog.show({ artifact, scope })
              }
            />
            {(appSource || artifact.mime === 'text/html') && (
              <IconButton
                icon={BrowserIcon}
                aria-label={t('artifacts.devPreview')}
                title={t('artifacts.devPreview')}
                onClick={() => setPanel('preview', scope.workspaceId)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Image-like thumbnail in the chat; the dialog is the interactive surface.
function ArtifactTile({
  artifact,
  scope,
  kind,
}: {
  artifact: ArtifactReference;
  scope: Scope;
  kind: InlinePreviewKind;
}) {
  const { t } = useTranslation('common');
  const { theme } = useTheme();
  const setPanel = useUiPreferencesStore(
    (state) => state.setRightMainPanelMode
  );
  const isDocument = kind === 'pdf' || kind === 'office';
  const query = useArtifactContent(
    artifact,
    scope,
    isDocument ? 'thumbnail' : 'preview'
  );
  const { run, busy, error: actionError } = useArtifactActions(artifact, scope);
  const needsUrl = kind === 'image' || isDocument;
  const url = useObjectUrl(needsUrl ? query.data?.blob : undefined);
  if (query.error)
    return (
      <ArtifactCard
        artifact={artifact}
        scope={scope}
        error={query.error.message}
      />
    );
  const open = () => {
    // The dialog cannot render raw image bytes; wait for the tile's own fetch.
    if (kind === 'image') {
      if (query.data)
        void ImagePreviewDialog.show({
          imageBlob: query.data.blob,
          altText: artifact.name,
          fileName: artifact.name.split('/').pop(),
          format: artifact.mime.split('/')[1],
          sizeBytes: BigInt(query.data.blob.size),
        });
      return;
    }
    void ArtifactPreviewDialog.show({ artifact, scope });
  };
  const renderPreview = () => {
    if (query.isPending || (needsUrl && !url))
      return (
        // Framed kinds always settle at 320px; reserve it so virtualized
        // rows do not resize once the snapshot arrives.
        <p
          role="status"
          className={`p-base text-low${kind === 'image' || kind === 'mermaid' ? '' : ' h-[320px]'}`}
        >
          {t('artifacts.loading')}
        </p>
      );
    const { text, preview } = query.data;
    switch (kind) {
      case 'image':
        return (
          <img
            src={url}
            alt={artifact.name}
            loading="lazy"
            className="mx-auto max-h-[320px] max-w-full object-contain"
          />
        );
      case 'mermaid':
        return (
          <MermaidDiagram
            chart={text}
            theme={getResolvedTheme(theme)}
            isolated
          />
        );
      case 'frame':
        // Half-scale page thumbnail that never scrolls; the overlay keeps
        // wheel and pointer events out of the frame in every browser.
        return preview ? (
          <div className="relative h-[320px] overflow-hidden bg-white">
            <iframe
              className="h-[640px] w-[200%] origin-top-left scale-50 border-0"
              title={artifact.name}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              loading="lazy"
              scrolling="no"
              srcDoc={preview.srcDoc}
            />
            <div className="absolute inset-0" />
          </div>
        ) : null;
      default:
        // sips renders PDF pages onto transparent pixels, so the page needs an
        // opaque sheet behind it or dark themes swallow the black glyphs.
        return (
          <div className="flex h-[320px] items-center justify-center">
            <img
              src={url}
              alt={artifact.name}
              loading="lazy"
              className="h-full max-w-full bg-white object-contain"
            />
          </div>
        );
    }
  };
  const note = actionError ?? artifact.error;
  return (
    <figure className="my-half overflow-hidden rounded-sm border border-border bg-panel text-base">
      {/* Thumbnails never trap wheel or clicks; frames stay inert until opened. */}
      <div
        className="max-h-[320px] cursor-zoom-in overflow-hidden [&_iframe]:pointer-events-none"
        onClick={open}
      >
        {renderPreview()}
      </div>
      <figcaption className="flex items-center gap-base border-t border-border px-base py-half">
        <span
          className="min-w-0 flex-1 truncate font-medium text-high"
          title={artifact.name}
        >
          {artifact.name.split('/').pop()}
        </span>
        {artifact.source_scope && (
          <span className="shrink-0 text-low">{t('artifacts.subagent')}</span>
        )}
        <IconButton
          icon={ArrowsOutSimpleIcon}
          aria-label={t('artifacts.expand')}
          title={t('artifacts.expand')}
          onClick={open}
        />
        {artifact.mime === 'text/html' && (
          <IconButton
            icon={BrowserIcon}
            aria-label={t('artifacts.devPreview')}
            title={t('artifacts.devPreview')}
            onClick={() => setPanel('preview', scope.workspaceId)}
          />
        )}
        <IconButton
          icon={busy ? SpinnerIcon : DownloadSimpleIcon}
          iconClassName={busy ? 'animate-spin' : undefined}
          aria-label={t('artifacts.download')}
          title={t('artifacts.download')}
          disabled={!!busy}
          onClick={() => void run('download')}
        />
      </figcaption>
      {note && (
        <p role="status" className="px-base pb-half text-low">
          {note}
        </p>
      )}
    </figure>
  );
}

export function ArtifactCards({
  artifacts,
  processId,
  workspaceId,
  sessionId,
}: {
  artifacts: ArtifactReference[];
  processId: string;
  workspaceId: string;
  sessionId: string;
}) {
  const hostId = useHostId();
  const scope = { processId, workspaceId, sessionId, hostId };
  return (
    <>
      {deduplicateManagedImages(artifacts).map((artifact) => {
        // Fenced Mermaid already renders inside the message itself.
        if (artifact.path === null && artifact.mime === 'text/vnd.mermaid')
          return null;
        const kind = inlinePreviewKind(artifact);
        return kind ? (
          <ArtifactTile
            key={artifact.id}
            artifact={artifact}
            scope={scope}
            kind={kind}
          />
        ) : (
          <ArtifactCard key={artifact.id} artifact={artifact} scope={scope} />
        );
      })}
    </>
  );
}

// Entry-bound and subagent-scoped artifacts render under their chat entry;
// only unbound legacy observations remain at the end of the execution.
export function ExecutionArtifactResults({
  processId,
  workspaceId,
  sessionId,
}: Omit<Scope, 'hostId'>) {
  const query = useExecutionArtifacts(processId, workspaceId, sessionId);
  const artifacts =
    query.data?.artifacts.filter(
      (artifact) => artifact.source_entry === null && !artifact.source_scope
    ) ?? [];
  if (!artifacts.length && !query.data?.warnings.length) return null;
  return (
    <div className="px-double pb-base">
      {query.data?.warnings.map((warning) => (
        <p key={warning} role="status" className="text-low text-sm">
          {warning}
        </p>
      ))}
      <ArtifactCards
        artifacts={artifacts}
        processId={processId}
        workspaceId={workspaceId}
        sessionId={sessionId}
      />
    </div>
  );
}
