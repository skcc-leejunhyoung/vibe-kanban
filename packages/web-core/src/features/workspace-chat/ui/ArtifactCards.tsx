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
import type { ArtifactReference } from 'shared/types';
import { ExecutionProcessStatus } from 'shared/types';
import { IconButton } from '@vibe/ui/components/IconButton';
import { openExternalUrl } from '@vibe/ui/lib/open-url';
import { Switch } from '@vibe/ui/components/Switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { artifactsApi } from '@/shared/lib/api';
import { defineModal } from '@/shared/lib/modals';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { ExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { MermaidDiagram } from '@/shared/components/MermaidDiagram';
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
function useArtifactContent(
  artifact: ArtifactReference,
  scope: Scope,
  mode: 'preview' | 'source'
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

function useArtifactDownload(artifact: ArtifactReference, scope: Scope) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string>();
  const download = async () => {
    setDownloading(true);
    setError(undefined);
    try {
      const blob = await artifactsApi.content(
        scope.processId,
        scope.workspaceId,
        scope.sessionId,
        artifact.id,
        scope.hostId,
        artifact.content_hash ?? undefined
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifact.name.split('/').pop() ?? 'artifact';
      anchor.click();
      // Let the browser consume the click before releasing the download URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloading(false);
    }
  };
  return { download, downloading, error };
}

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
  const {
    download,
    downloading,
    error: downloadError,
  } = useArtifactDownload(artifact, scope);
  const query = useArtifactContent(artifact, scope, mode);
  const documentUrl = useObjectUrl(isDocument ? query.data?.blob : undefined);
  const renderContent = () => {
    if (query.isPending) return <p role="status">{t('artifacts.loading')}</p>;
    if (query.error) return <p role="alert">{query.error.message}</p>;
    const { text, preview, warnings } = query.data;
    if (mode === 'source')
      return (
        <pre className="overflow-auto whitespace-pre-wrap p-base text-base font-ibm-plex-mono">
          {text || t('artifacts.binary')}
        </pre>
      );
    if (preview)
      return (
        <>
          {runtimeError && <p role="alert">{runtimeError}</p>}
          {[...warnings, ...preview.warnings].map((warning) => (
            <p key={warning} className="text-low">
              {warning}
            </p>
          ))}
          <iframe
            ref={frameRef}
            className="h-[65vh] w-full border-0 bg-white"
            title={artifact.name}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={preview.srcDoc}
          />
          <p className="text-low">{t('artifacts.staticPreview')}</p>
        </>
      );
    if (isDocument)
      return (
        <>
          {warnings.map((warning) => (
            <p key={warning} className="text-low">
              {warning}
            </p>
          ))}
          {documentUrl && (
            <iframe
              className="h-[75vh] w-full border-0 bg-white"
              title={artifact.name}
              src={documentUrl}
            />
          )}
        </>
      );
    if (artifact.mime === 'text/vnd.mermaid')
      return (
        <MermaidDiagram chart={text} theme={getResolvedTheme(theme)} isolated />
      );
    if (artifact.mime === 'text/markdown')
      return (
        <MarkdownPreview
          content={text}
          theme={getResolvedTheme(theme)}
          allowRemoteImages={false}
        />
      );
    return (
      <pre className="overflow-auto whitespace-pre-wrap p-base font-ibm-plex-mono">
        {text || t('artifacts.binary')}
      </pre>
    );
  };
  return (
    <>
      <DialogHeader className="pr-double">
        <div className="flex min-w-0 items-center gap-base">
          <DialogTitle
            className="min-w-0 flex-1 truncate"
            title={artifact.name}
          >
            {artifact.name}
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-base">
            {canToggleSource && (
              <label className="flex items-center gap-half whitespace-nowrap text-base text-low">
                {t('artifacts.source')}
                <Switch
                  checked={showSource}
                  onCheckedChange={setShowSource}
                  aria-label={t('artifacts.source')}
                />
              </label>
            )}
            <IconButton
              icon={downloading ? SpinnerIcon : DownloadSimpleIcon}
              iconClassName={downloading ? 'animate-spin' : undefined}
              aria-label={t('artifacts.download')}
              title={t('artifacts.download')}
              disabled={downloading}
              onClick={() => void download()}
            />
          </div>
        </div>
      </DialogHeader>
      {downloadError && <p role="alert">{downloadError}</p>}
      {renderContent()}
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
        size="5xl"
      >
        <DialogContent className="max-h-[85vh] overflow-auto p-base">
          {modal.visible && (
            <ArtifactViewer artifact={artifact} scope={scope} onClose={close} />
          )}
        </DialogContent>
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
  const query = useArtifactContent(artifact, scope, 'preview');
  const {
    download,
    downloading,
    error: downloadError,
  } = useArtifactDownload(artifact, scope);
  const needsUrl = kind === 'image' || kind === 'pdf' || kind === 'office';
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
        return preview ? (
          <iframe
            className="h-[320px] w-full border-0 bg-white"
            title={artifact.name}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
            srcDoc={preview.srcDoc}
          />
        ) : null;
      default:
        return (
          <iframe
            className="h-[320px] w-full border-0 bg-white"
            title={artifact.name}
            loading="lazy"
            src={`${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
          />
        );
    }
  };
  const note = downloadError ?? artifact.error;
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
          icon={downloading ? SpinnerIcon : DownloadSimpleIcon}
          iconClassName={downloading ? 'animate-spin' : undefined}
          aria-label={t('artifacts.download')}
          title={t('artifacts.download')}
          disabled={downloading}
          onClick={() => void download()}
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
