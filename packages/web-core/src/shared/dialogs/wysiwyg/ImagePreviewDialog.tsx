import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@vibe/ui/components/KeyboardDialog';
import { create, useModal } from '@ebay/nice-modal-react';
import { Download, Loader2, Share2 } from 'lucide-react';
import { ZoomPane } from '@/shared/components/ZoomPane';
import { defineModal } from '@/shared/lib/modals';
import { formatFileSize } from '@/shared/lib/utils';

export interface ImagePreviewDialogProps {
  imageUrl?: string;
  imageBlob?: Blob;
  altText: string;
  fileName?: string;
  format?: string;
  sizeBytes?: bigint | null;
}

const ImagePreviewDialogImpl = create<ImagePreviewDialogProps>((props) => {
  const modal = useModal();
  const { t } = useTranslation();
  const { imageUrl, imageBlob, altText, fileName, format, sizeBytes } = props;
  const [imageLoaded, setImageLoaded] = useState(false);
  const [ownedImage, setOwnedImage] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    setImageLoaded(false);
    if (!imageBlob || !modal.visible) return;
    // The dialog outlives a virtualized chat row and must own its preview URL.
    const url = URL.createObjectURL(imageBlob);
    setOwnedImage({ blob: imageBlob, url });
    return () => URL.revokeObjectURL(url);
  }, [imageBlob, imageUrl, modal.visible]);
  const previewUrl = imageBlob
    ? ownedImage?.blob === imageBlob
      ? ownedImage.url
      : undefined
    : imageUrl;

  const handleClose = () => {
    modal.resolve();
    void modal.hide();
    modal.remove();
  };

  const loadBlob = async () => {
    if (imageBlob) return imageBlob;
    if (!previewUrl) return null;
    const response = await fetch(previewUrl);
    if (!response.ok) throw new Error('Failed to fetch image');
    return response.blob();
  };

  const handleDownload = async () => {
    try {
      const blob = await loadBlob();
      if (!blob) return;
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = fileName || altText || 'image';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (error) {
      console.error('Failed to download image:', error);
    }
  };

  // Web Share hands the file to the native sheet (Save Image, Files, other
  // apps); a page cannot launch the system viewer directly.
  const canShare = typeof navigator.share === 'function';
  const handleShare = async () => {
    try {
      const blob = await loadBlob();
      if (!blob) return;
      const base = fileName || altText || 'image';
      const extension = blob.type.split('/')[1]?.split('+')[0];
      const name =
        /\.[a-z0-9]+$/i.test(base) || !extension
          ? base
          : `${base}.${extension}`;
      const file = new File([blob], name, { type: blob.type });
      if (!navigator.canShare?.({ files: [file] })) return handleDownload();
      await navigator.share({ files: [file] });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('Failed to share image:', error);
    }
  };

  // Build metadata string
  const metadataParts: string[] = [];
  if (format) {
    metadataParts.push(format.toUpperCase());
  }
  const sizeStr = formatFileSize(sizeBytes);
  if (sizeStr) {
    metadataParts.push(sizeStr);
  }
  const metadataLine = metadataParts.join(' · ');

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={handleClose}
      fullscreen
      aria-label={fileName || altText}
    >
      <ZoomPane>
        <img
          src={previewUrl}
          alt={altText}
          draggable={false}
          className={`block max-h-dvh max-w-[100vw] ${
            imageLoaded ? 'opacity-100' : 'opacity-0'
          }`}
          onLoad={() => setImageLoaded(true)}
        />
      </ZoomPane>
      {!imageLoaded && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-white/70" />
        </div>
      )}
      {fileName && (
        <p className="pointer-events-none absolute inset-x-0 top-0 truncate bg-gradient-to-b from-black/70 to-transparent px-4 pb-8 pr-16 pt-[max(1rem,env(safe-area-inset-top))] text-sm">
          {fileName}
        </p>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-4 bg-black/60 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 text-xs">
        <p className="truncate text-white/70">{metadataLine}</p>
        <div className="flex shrink-0 items-center gap-4">
          {canShare && (
            <button
              onClick={() => void handleShare()}
              className="text-white/70 transition-colors hover:text-white"
              type="button"
              aria-label={t('kanban.shareAttachment')}
              title={t('kanban.shareAttachment')}
            >
              <Share2 className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => void handleDownload()}
            className="text-white/70 transition-colors hover:text-white"
            type="button"
            aria-label={t('kanban.downloadAttachment')}
            title={t('kanban.downloadAttachment')}
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      </div>
    </Dialog>
  );
});

export const ImagePreviewDialog = defineModal<ImagePreviewDialogProps, void>(
  ImagePreviewDialogImpl
);
