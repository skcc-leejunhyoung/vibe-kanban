import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { NodeKey, SerializedLexicalNode, Spread, $getNodeByKey } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { Download, File, HelpCircle, Loader2, X } from 'lucide-react';
import {
  useWorkspaceId,
  useSessionId,
  useLocalAttachments,
  type LocalAttachmentMetadata,
} from './WorkspaceContext';
import {
  createDecoratorNode,
  type DecoratorNodeConfig,
} from './create-decorator-node';
import {
  escapeMarkdownImageAltText,
  IMAGE_MARKDOWN_PATTERN,
  unescapeMarkdownImageAltText,
} from '@vibe/ui/lib/githubImageMarkdown';
import { openExternalUrl } from '@vibe/ui/lib/open-url';

const ATTACHMENT_URL_STALE_TIME = 4 * 60 * 1000;
const IMAGE_FILE_EXTENSION_REGEX =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i;
const GITHUB_ATTACHMENT_PATH_PREFIX = '/user-attachments/assets/';

type AttachmentType = 'file' | 'thumbnail';

interface AttachmentUrlResult {
  url: string | null;
  loading: boolean;
}

interface ImageMetadataLike {
  exists: boolean;
  file_name?: string | null;
  size_bytes?: bigint | null;
  format?: string | null;
  proxy_url?: string | null;
}

export interface OpenImagePreviewOptions {
  imageUrl: string;
  altText: string;
  fileName?: string;
  format?: string;
  sizeBytes?: bigint | null;
}

export interface CreateImageNodeOptions {
  fetchAttachmentUrl: (
    attachmentId: string,
    type: AttachmentType
  ) => Promise<string>;
  fetchGitHubImage?: (sourceUrl: string) => Promise<Blob>;
  /** Fetch a workspace-relative image (e.g. an agent screenshot referenced in
   * Markdown) as a Blob via the host-aware API; null when rejected/missing. */
  fetchWorkspaceImage?: (
    workspaceId: string,
    sessionId: string,
    path: string
  ) => Promise<Blob | null>;
  onGitHubImageAuthorizationRequired?: (
    error: unknown
  ) => Promise<boolean> | boolean;
  onGitHubImageAuthorizationRequested?: () => Promise<boolean> | boolean;
  openImagePreview: (options: OpenImagePreviewOptions) => void;
}

export interface ImageData {
  src: string;
  altText: string;
}

export type SerializedImageNode = Spread<
  {
    src: string;
    altText: string;
  },
  SerializedLexicalNode
>;

function isImageLikeFileName(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) {
    return false;
  }

  return IMAGE_FILE_EXTENSION_REGEX.test(normalized);
}

/** True for scheme-less, non-absolute paths like `screenshots/login.png` that
 * can be served from inside the workspace. The scheme test also rejects
 * Windows drive paths (`C:\…`). */
function isWorkspaceRelativePath(src: string): boolean {
  return !src.startsWith('/') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src);
}

function isGitHubAttachmentUrl(src: string): boolean {
  try {
    const url = new URL(src);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith(GITHUB_ATTACHMENT_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

function truncatePath(path: string, maxLength = 24): string {
  const filename = path.split('/').pop() || path;
  if (filename.length <= maxLength) return filename;
  return filename.slice(0, maxLength - 3) + '...';
}

function formatFileSize(bytes: bigint | number | null | undefined): string {
  if (!bytes) return '';
  const num = Number(bytes);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadBlobUrl(url: string, filename: string): Promise<void> {
  const response = await fetch(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
  });

  if (!response.ok) {
    throw new Error('Failed to download attachment');
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function toMetadataFromLocalImage(
  localImage: LocalAttachmentMetadata | undefined
): ImageMetadataLike | null {
  if (!localImage) return null;

  return {
    exists: true,
    file_name: localImage.file_name,
    size_bytes: BigInt(localImage.size_bytes),
    format: localImage.format,
    proxy_url: localImage.proxy_url,
  };
}

function useImageMetadata(
  workspaceId: string | undefined,
  sessionId: string | undefined,
  src: string,
  localAttachments: LocalAttachmentMetadata[]
) {
  const isVibeImage = src.startsWith('.vibe-attachments/');

  const localImage = useMemo(
    () => localAttachments.find((attachment) => attachment.path === src),
    [localAttachments, src]
  );

  const localImageMetadata = useMemo(
    () => toMetadataFromLocalImage(localImage),
    [localImage]
  );

  const shouldFetch = isVibeImage && !!workspaceId && !localImage;

  const query = useQuery({
    queryKey: ['image-metadata', workspaceId, sessionId, src],
    queryFn: async (): Promise<ImageMetadataLike | null> => {
      if (!workspaceId || !sessionId) return null;

      const response = await fetch(
        `/api/workspaces/${workspaceId}/attachments/metadata?path=${encodeURIComponent(src)}&session_id=${sessionId}`
      );
      const payload = await response.json();
      return payload.data as ImageMetadataLike | null;
    },
    enabled: shouldFetch && !!sessionId,
    staleTime: Infinity,
  });

  return {
    data: localImageMetadata ?? query.data,
    isLoading: localImage ? false : query.isLoading,
  };
}

function useAttachmentUrl(
  attachmentId: string | null,
  type: AttachmentType,
  fetchAttachmentUrl: CreateImageNodeOptions['fetchAttachmentUrl']
): AttachmentUrlResult {
  const query = useQuery({
    queryKey: ['attachment-url', attachmentId, type],
    queryFn: () => fetchAttachmentUrl(attachmentId as string, type),
    enabled: !!attachmentId,
    staleTime: ATTACHMENT_URL_STALE_TIME,
  });

  return {
    url: query.data ?? null,
    loading: query.isLoading,
  };
}

function useWorkspacePathImageUrl(
  path: string | null,
  workspaceId: string | undefined,
  sessionId: string | undefined,
  fetchWorkspaceImage: CreateImageNodeOptions['fetchWorkspaceImage']
): AttachmentUrlResult {
  const enabled =
    !!path && !!workspaceId && !!sessionId && !!fetchWorkspaceImage;
  const query = useQuery({
    queryKey: ['workspace-path-image', workspaceId, sessionId, path],
    queryFn: () => fetchWorkspaceImage!(workspaceId!, sessionId!, path!),
    enabled,
    staleTime: ATTACHMENT_URL_STALE_TIME,
  });

  const blob = query.data ?? null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return { url, loading: enabled && (query.isLoading || (!!query.data && !url)) };
}

function useGitHubImageUrl(
  sourceUrl: string | null,
  fetchGitHubImage: CreateImageNodeOptions['fetchGitHubImage'],
  onGitHubImageAuthorizationRequired: CreateImageNodeOptions['onGitHubImageAuthorizationRequired'],
  onGitHubImageAuthorizationRequested: CreateImageNodeOptions['onGitHubImageAuthorizationRequested']
): AttachmentUrlResult & {
  handleImageError: () => void;
  requestAuthorization: () => void;
} {
  const [url, setUrl] = useState<string | null>(sourceUrl);
  const [loading, setLoading] = useState(false);
  const [hasTriedProxy, setHasTriedProxy] = useState(false);
  const [authorizationRetry, setAuthorizationRetry] = useState(0);
  const objectUrlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const hasRequestedAuthorizationRef = useRef(false);

  useEffect(() => {
    requestIdRef.current += 1;
    setUrl(sourceUrl);
    setLoading(false);
    setHasTriedProxy(false);
    setAuthorizationRetry(0);
    hasRequestedAuthorizationRef.current = false;

    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [sourceUrl]);

  const fetchProxy = useCallback(
    (force = false) => {
      if (!sourceUrl || !fetchGitHubImage || (hasTriedProxy && !force)) return;

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setHasTriedProxy(true);
      setLoading(true);
      fetchGitHubImage(sourceUrl)
        .then((blob) => {
          if (requestId !== requestIdRef.current) return;
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
          }
          const objectUrl = URL.createObjectURL(blob);
          objectUrlRef.current = objectUrl;
          setUrl(objectUrl);
        })
        .catch(async (error) => {
          if (
            requestId === requestIdRef.current &&
            !hasRequestedAuthorizationRef.current &&
            onGitHubImageAuthorizationRequired
          ) {
            hasRequestedAuthorizationRef.current = true;
            const reauthorized =
              await onGitHubImageAuthorizationRequired(error);
            if (requestId === requestIdRef.current && reauthorized) {
              setAuthorizationRetry((value) => value + 1);
              return;
            }
          }
          if (requestId === requestIdRef.current) setUrl(null);
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false);
        });
    },
    [
      fetchGitHubImage,
      hasTriedProxy,
      onGitHubImageAuthorizationRequired,
      sourceUrl,
    ]
  );

  useEffect(() => {
    if (authorizationRetry > 0) {
      fetchProxy(true);
    }
  }, [authorizationRetry, fetchProxy]);

  const handleImageError = useCallback(() => {
    if (hasTriedProxy) {
      setUrl(null);
      return;
    }
    fetchProxy();
  }, [fetchProxy, hasTriedProxy]);

  const requestAuthorization = useCallback(() => {
    if (!onGitHubImageAuthorizationRequested) return;

    void Promise.resolve(onGitHubImageAuthorizationRequested())
      .then((reauthorized) => {
        if (reauthorized) {
          setAuthorizationRetry((value) => value + 1);
        }
      })
      .catch(() => {});
  }, [onGitHubImageAuthorizationRequested]);

  return { url, loading, handleImageError, requestAuthorization };
}

export function createImageNode(options: CreateImageNodeOptions) {
  function ImageComponent({
    data,
    nodeKey,
    onDoubleClickEdit,
  }: {
    data: ImageData;
    nodeKey: NodeKey;
    onDoubleClickEdit: (event: React.MouseEvent) => void;
  }): JSX.Element {
    const { t } = useTranslation('common');
    const { src, altText } = data;
    const isGitHubAttachment = isGitHubAttachmentUrl(src);
    const workspaceId = useWorkspaceId();
    const sessionId = useSessionId();
    const localAttachments = useLocalAttachments();
    const [editor] = useLexicalComposerContext();

    const isVibeImage = src.startsWith('.vibe-attachments/');
    const isPendingAttachment = src.startsWith('pending-attachment://');
    const isAttachment = isPendingAttachment || src.startsWith('attachment://');
    const attachmentId =
      !isPendingAttachment && isAttachment
        ? src.replace('attachment://', '')
        : null;
    const localAttachment = useMemo(
      () => localAttachments.find((attachment) => attachment.path === src),
      [localAttachments, src]
    );
    const isImageAttachment =
      isAttachment &&
      (localAttachment?.mime_type?.startsWith('image/') ||
        isImageLikeFileName(altText));
    // Markdown image with a workspace-relative path (e.g. an agent-saved
    // screenshot) — rendered full size like GitHub attachments.
    const isWorkspacePathImage =
      !isVibeImage &&
      !isAttachment &&
      !isGitHubAttachment &&
      isWorkspaceRelativePath(src) &&
      isImageLikeFileName(src);

    const { url: workspacePathImageUrl, loading: workspacePathImageLoading } =
      useWorkspacePathImageUrl(
        isWorkspacePathImage ? src : null,
        workspaceId,
        sessionId,
        options.fetchWorkspaceImage
      );

    const { url: thumbnailUrl, loading: attachmentLoading } = useAttachmentUrl(
      isImageAttachment && !localAttachment ? attachmentId : null,
      'thumbnail',
      options.fetchAttachmentUrl
    );
    const { url: fullSizeUrl } = useAttachmentUrl(
      localAttachment ? null : attachmentId,
      'file',
      options.fetchAttachmentUrl
    );
    const {
      url: githubImageUrl,
      loading: githubImageLoading,
      handleImageError: handleGitHubImageError,
      requestAuthorization: requestGitHubImageAuthorization,
    } = useGitHubImageUrl(
      isGitHubAttachment ? src : null,
      options.fetchGitHubImage,
      options.onGitHubImageAuthorizationRequired,
      options.onGitHubImageAuthorizationRequested
    );

    const { data: metadata, isLoading: loading } = useImageMetadata(
      workspaceId,
      sessionId,
      src,
      localAttachments
    );
    const workspaceDisplayName =
      metadata?.file_name || localAttachment?.file_name || altText || src;
    const isWorkspaceImage =
      isVibeImage &&
      ((localAttachment?.mime_type?.startsWith('image/') ?? false) ||
        isImageLikeFileName(workspaceDisplayName));
    const showDownloadButton = Boolean(
      (isAttachment &&
        (localAttachment?.proxy_url || fullSizeUrl || metadata?.proxy_url)) ||
        (!isWorkspaceImage && metadata?.proxy_url)
    );

    const handleClick = useCallback(
      (event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        if (isGitHubAttachment && githubImageUrl) {
          options.openImagePreview({
            imageUrl: githubImageUrl,
            altText,
            fileName: altText || undefined,
          });
          return;
        }

        if (isWorkspacePathImage && workspacePathImageUrl) {
          options.openImagePreview({
            imageUrl: workspacePathImageUrl,
            altText: altText || src,
            fileName: src.split('/').pop() || src,
          });
          return;
        }

        const localAttachmentUrl = localAttachment?.proxy_url ?? null;

        if (isAttachment && (localAttachmentUrl || fullSizeUrl)) {
          const resolvedFullSizeUrl = localAttachmentUrl || fullSizeUrl;
          if (!resolvedFullSizeUrl) return;

          if (isImageAttachment && (localAttachmentUrl || thumbnailUrl)) {
            options.openImagePreview({
              imageUrl: resolvedFullSizeUrl,
              altText,
              fileName: altText || undefined,
            });
          } else {
            openExternalUrl(resolvedFullSizeUrl);
          }
          return;
        }

        if (metadata?.exists && metadata.proxy_url) {
          if (isWorkspaceImage) {
            options.openImagePreview({
              imageUrl: metadata.proxy_url,
              altText,
              fileName: metadata.file_name ?? undefined,
              format: metadata.format ?? undefined,
              sizeBytes: metadata.size_bytes,
            });
          } else {
            openExternalUrl(metadata.proxy_url);
          }
        }
      },
      [
        isAttachment,
        isGitHubAttachment,
        githubImageUrl,
        isWorkspacePathImage,
        workspacePathImageUrl,
        src,
        localAttachment?.proxy_url,
        fullSizeUrl,
        isImageAttachment,
        thumbnailUrl,
        metadata,
        isWorkspaceImage,
        altText,
      ]
    );

    const handleDownload = useCallback(
      (event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        const downloadUrl =
          localAttachment?.proxy_url ??
          fullSizeUrl ??
          (!isWorkspaceImage ? (metadata?.proxy_url ?? null) : null);
        if (!downloadUrl) return;

        downloadBlobUrl(downloadUrl, altText || 'attachment').catch((error) => {
          console.error('Failed to download attachment:', error);
        });
      },
      [
        localAttachment?.proxy_url,
        fullSizeUrl,
        isWorkspaceImage,
        metadata,
        altText,
      ]
    );

    const handleDelete = useCallback(
      (event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        if (!editor.isEditable()) return;

        editor.update(() => {
          const node = $getNodeByKey(nodeKey);
          if (node) {
            node.remove();
          }
        });
      },
      [editor, nodeKey]
    );

    if (isGitHubAttachment) {
      return (
        <span
          className="group relative inline-block max-w-full cursor-zoom-in"
          onClick={handleClick}
          onDoubleClick={onDoubleClickEdit}
          role="button"
          tabIndex={0}
        >
          {githubImageLoading ? (
            <div className="w-10 h-10 flex items-center justify-center bg-muted rounded">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </div>
          ) : githubImageUrl ? (
            <img
              src={githubImageUrl}
              alt={altText}
              className="max-w-full max-h-[640px] rounded border border-border object-contain"
              draggable={false}
              loading="lazy"
              onError={handleGitHubImageError}
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex items-center gap-2 rounded bg-muted p-2">
              <HelpCircle className="w-5 h-5 text-muted-foreground" />
              {options.onGitHubImageAuthorizationRequested && (
                <button
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    requestGitHubImageAuthorization();
                  }}
                  className="text-xs text-primary hover:underline"
                  type="button"
                >
                  {t('oauth.reauthenticateGitHub')}
                </button>
              )}
            </div>
          )}
          {editor.isEditable() && (
            <button
              onClick={handleDelete}
              className="absolute top-1 right-1 w-4 h-4 rounded-full bg-foreground/70 hover:bg-destructive flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={t('kanban.removeImage')}
              type="button"
            >
              <X className="w-2.5 h-2.5 text-background" />
            </button>
          )}
        </span>
      );
    }

    // Workspace-relative markdown image: render full size while the blob is
    // available; otherwise fall through to the generic chip below.
    if (
      isWorkspacePathImage &&
      (workspacePathImageLoading || workspacePathImageUrl)
    ) {
      return (
        <span
          className="group relative inline-block max-w-full cursor-zoom-in"
          onClick={handleClick}
          onDoubleClick={onDoubleClickEdit}
          role="button"
          tabIndex={0}
        >
          {workspacePathImageUrl ? (
            <img
              src={workspacePathImageUrl}
              alt={altText || src}
              title={src}
              className="max-w-full max-h-[640px] rounded border border-border object-contain"
              draggable={false}
              loading="lazy"
            />
          ) : (
            <span className="w-10 h-10 flex items-center justify-center bg-muted rounded">
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            </span>
          )}
          {editor.isEditable() && (
            <button
              onClick={handleDelete}
              className="absolute top-1 right-1 w-4 h-4 rounded-full bg-foreground/70 hover:bg-destructive flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={t('kanban.removeImage')}
              type="button"
            >
              <X className="w-2.5 h-2.5 text-background" />
            </button>
          )}
        </span>
      );
    }

    let thumbnailContent: React.ReactNode;
    let displayName: string;
    let metadataLine: string | null = null;

    const hasContext = !!workspaceId;
    const hasLocalImage = localAttachments.some(
      (attachment) => attachment.path === src
    );

    if (isAttachment) {
      const previewUrl = localAttachment?.proxy_url ?? thumbnailUrl;

      if (isImageAttachment && !localAttachment && attachmentLoading) {
        thumbnailContent = (
          <div className="w-10 h-10 flex items-center justify-center bg-muted rounded flex-shrink-0">
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
          </div>
        );
      } else if (isImageAttachment && previewUrl) {
        thumbnailContent = (
          <img
            src={previewUrl}
            alt={altText}
            className="w-10 h-10 object-cover rounded flex-shrink-0"
            draggable={false}
          />
        );
      } else {
        thumbnailContent = (
          <div className="w-10 h-10 flex items-center justify-center bg-muted rounded flex-shrink-0">
            <File className="w-5 h-5 text-muted-foreground" />
          </div>
        );
      }
      displayName = truncatePath(
        altText || t('kanban.imageAttachmentNameFallback')
      );
      if (localAttachment?.is_pending) {
        const parts = ['Uploading'];
        const sizeText = formatFileSize(localAttachment.size_bytes);
        if (sizeText) {
          parts.push(sizeText);
        }
        metadataLine = parts.join(' · ');
      }
      if (!isImageAttachment) {
        const format = altText.split('.').pop()?.trim();
        metadataLine = format ? format.toUpperCase() : null;
      }
    } else if (isVibeImage && (hasLocalImage || hasContext)) {
      if (!isWorkspaceImage) {
        thumbnailContent = (
          <div className="w-10 h-10 flex items-center justify-center bg-muted rounded flex-shrink-0">
            <File className="w-5 h-5 text-muted-foreground" />
          </div>
        );
        displayName = truncatePath(workspaceDisplayName);
        const parts: string[] = [];
        if (metadata?.format) {
          parts.push(metadata.format.toUpperCase());
        }
        const sizeText = formatFileSize(metadata?.size_bytes);
        if (sizeText) {
          parts.push(sizeText);
        }
        metadataLine = parts.length > 0 ? parts.join(' · ') : null;
      } else if (loading) {
        thumbnailContent = (
          <div className="w-10 h-10 flex items-center justify-center bg-muted rounded flex-shrink-0">
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
          </div>
        );
        displayName = truncatePath(src);
      } else if (metadata?.exists && metadata.proxy_url) {
        thumbnailContent = (
          <img
            src={metadata.proxy_url}
            alt={altText}
            className="w-10 h-10 object-cover rounded flex-shrink-0"
            draggable={false}
          />
        );
        displayName = truncatePath(workspaceDisplayName);

        const parts: string[] = [];
        if (metadata.format) {
          parts.push(metadata.format.toUpperCase());
        }
        const sizeText = formatFileSize(metadata.size_bytes);
        if (sizeText) {
          parts.push(sizeText);
        }
        if (parts.length > 0) {
          metadataLine = parts.join(' · ');
        }
      } else {
        thumbnailContent = (
          <div className="w-10 h-10 flex items-center justify-center bg-muted rounded flex-shrink-0">
            <HelpCircle className="w-5 h-5 text-muted-foreground" />
          </div>
        );
        displayName = truncatePath(src);
      }
    } else if (!isVibeImage) {
      thumbnailContent = (
        <div className="w-10 h-10 flex items-center justify-center bg-muted rounded flex-shrink-0">
          <HelpCircle className="w-5 h-5 text-muted-foreground" />
        </div>
      );
      displayName = truncatePath(altText || src);
    } else {
      thumbnailContent = (
        <div className="w-10 h-10 flex items-center justify-center bg-muted rounded flex-shrink-0">
          <HelpCircle className="w-5 h-5 text-muted-foreground" />
        </div>
      );
      displayName = truncatePath(src);
    }

    return (
      <span
        className="group relative inline-flex items-center gap-1.5 pl-1.5 pr-5 py-1 ml-0.5 mr-0.5 bg-muted rounded border cursor-pointer border-border hover:border-muted-foreground transition-colors align-bottom"
        onClick={handleClick}
        onDoubleClick={onDoubleClickEdit}
        role="button"
        tabIndex={0}
      >
        {thumbnailContent}
        <span className="flex flex-col min-w-0">
          <span className="text-xs text-muted-foreground truncate max-w-[120px]">
            {displayName}
          </span>
          {metadataLine && (
            <span className="text-[10px] text-muted-foreground/70 truncate max-w-[120px]">
              {metadataLine}
            </span>
          )}
        </span>
        {editor.isEditable() && (
          <button
            onClick={handleDelete}
            className="absolute top-1 right-1 w-4 h-4 rounded-full bg-foreground/70 hover:bg-destructive flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label={t('kanban.removeImage')}
            type="button"
          >
            <X className="w-2.5 h-2.5 text-background" />
          </button>
        )}
        {showDownloadButton ? (
          <button
            onClick={handleDownload}
            className={
              editor.isEditable()
                ? 'absolute top-1 right-6 w-4 h-4 rounded-full bg-foreground/70 hover:bg-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity'
                : 'absolute top-1 right-1 w-4 h-4 rounded-full bg-foreground/70 hover:bg-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity'
            }
            aria-label={t('kanban.downloadAttachment')}
            type="button"
          >
            <Download className="w-2.5 h-2.5 text-background" />
          </button>
        ) : null}
      </span>
    );
  }

  const config: DecoratorNodeConfig<ImageData> = {
    type: 'image',
    serialization: {
      format: 'inline',
      pattern: IMAGE_MARKDOWN_PATTERN,
      trigger: ')',
      serialize: (data) =>
        `![${escapeMarkdownImageAltText(data.altText)}](${data.src})`,
      deserialize: (match) => ({
        src: match[2],
        altText: unescapeMarkdownImageAltText(match[1]),
      }),
    },
    component: ImageComponent,
    domStyle: {
      display: 'inline-block',
      paddingLeft: '2px',
      paddingRight: '2px',
      verticalAlign: 'bottom',
    },
    keyboardSelectable: false,
    importDOM: (createNode) => ({
      img: () => ({
        conversion: (element: HTMLElement) => {
          const imageElement = element as HTMLImageElement;
          return {
            node: createNode({
              src: imageElement.getAttribute('src') || '',
              altText: imageElement.getAttribute('alt') || '',
            }),
          };
        },
        priority: 0,
      }),
    }),
    exportDOM: (data) => {
      const img = document.createElement('img');
      img.setAttribute('src', data.src);
      img.setAttribute('alt', data.altText);
      return img;
    },
  };

  const result = createDecoratorNode(config);

  return {
    ImageNode: result.Node,
    $createImageNode: (src: string, altText: string) =>
      result.createNode({ src, altText }),
    $isImageNode: result.isNode,
    IMAGE_TRANSFORMER: result.transformers[0],
  };
}
