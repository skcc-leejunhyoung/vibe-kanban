import { useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create, useModal } from '@ebay/nice-modal-react';
import { useTranslation } from 'react-i18next';
import {
  ArrowSquareOutIcon,
  BrowserIcon,
  DownloadSimpleIcon,
  EyeIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import type { ArtifactReference } from 'shared/types';
import { ExecutionProcessStatus } from 'shared/types';
import { IconButton } from '@vibe/ui/components/IconButton';
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
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const [runtimeError, setRuntimeError] = useState<string>();
  const mode = showSource ? 'source' : 'preview';
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
  const { processId, workspaceId, sessionId, hostId } = scope;
  const download = async () => {
    setDownloading(true);
    setDownloadError(undefined);
    try {
      const blob = await artifactsApi.content(
        processId,
        workspaceId,
        sessionId,
        artifact.id,
        hostId,
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
      setDownloadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloading(false);
    }
  };
  const query = useQuery({
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
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const blob = await artifactsApi.content(
        processId,
        workspaceId,
        sessionId,
        artifact.id,
        hostId,
        artifact.content_hash ?? undefined,
        signal
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
        const resources = await Promise.all(
          bundle.resources.map(async (resource) => ({
            ...resource,
            bytes: new Uint8Array(
              await (
                await artifactsApi.content(
                  processId,
                  workspaceId,
                  sessionId,
                  artifact.id,
                  hostId,
                  resource.content_hash,
                  signal
                )
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
      return { blob, text, preview: undefined, warnings: [] };
    },
  });
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
}: {
  artifact: ArtifactReference;
  scope: Scope;
}) {
  const { t } = useTranslation('common');
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const setPanel = useUiPreferencesStore(
    (state) => state.setRightMainPanelMode
  );
  const ready = !!artifact.content_hash && artifact.status !== 'preparing';
  const appSource = /\.(tsx|jsx|vue|svelte)$/i.test(artifact.name);
  const preview = async () => {
    if (
      !/^image\/(png|jpeg|gif|webp|bmp|x-icon|vnd.microsoft.icon|tiff)$/.test(
        artifact.mime
      )
    ) {
      void ArtifactPreviewDialog.show({ artifact, scope });
      return;
    }
    setOpening(true);
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
      void ImagePreviewDialog.show({
        imageBlob: new Blob([blob], { type: artifact.mime }),
        altText: artifact.name,
        fileName: artifact.name.split('/').pop(),
        format: artifact.mime.split('/')[1],
        sizeBytes: BigInt(blob.size),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  };
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
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('artifacts.openOriginal')}
            title={t('artifacts.openOriginal')}
            className="flex items-center justify-center rounded-sm p-half text-low hover:bg-secondary/50 hover:text-normal"
          >
            <ArrowSquareOutIcon className="size-icon-sm" weight="bold" />
          </a>
        ) : (
          <>
            <IconButton
              icon={opening ? SpinnerIcon : EyeIcon}
              iconClassName={opening ? 'animate-spin' : undefined}
              aria-label={t('artifacts.preview')}
              title={t('artifacts.preview')}
              disabled={!ready || opening}
              onClick={() => void preview()}
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
  return (
    <>
      {deduplicateManagedImages(artifacts).map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          scope={{ processId, workspaceId, sessionId, hostId }}
        />
      ))}
    </>
  );
}

export function ExecutionArtifactResults({
  processId,
  workspaceId,
  sessionId,
}: Omit<Scope, 'hostId'>) {
  const query = useExecutionArtifacts(processId, workspaceId, sessionId);
  const artifacts =
    query.data?.artifacts.filter(
      (artifact) => artifact.source_entry === null || artifact.source_scope
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
