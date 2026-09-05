import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { create, useModal } from '@ebay/nice-modal-react';
import { Download, Loader2 } from 'lucide-react';
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

  const handleDownload = async () => {
    if (!previewUrl) return;
    try {
      const response = await fetch(previewUrl);
      if (!response.ok) throw new Error('Failed to fetch image');
      const blob = await response.blob();
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
    <Dialog open={modal.visible} onOpenChange={handleClose} size="5xl">
      <DialogContent className="w-full p-0 overflow-hidden">
        {fileName && (
          <DialogHeader className="px-4 pt-4 pb-0">
            <DialogTitle className="truncate">{fileName}</DialogTitle>
          </DialogHeader>
        )}
        <div className="relative flex items-center justify-center min-h-[220px] max-h-[76vh] px-4 pb-4">
          {!imageLoaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
            </div>
          )}
          <img
            src={previewUrl}
            alt={altText}
            className={`max-w-full max-h-[70vh] object-contain ${
              imageLoaded ? 'opacity-100' : 'opacity-0'
            }`}
            onLoad={() => setImageLoaded(true)}
          />
        </div>
        <DialogFooter className="px-4 py-3 border-t sm:justify-between">
          <p className="text-xs text-muted-foreground">{metadataLine}</p>
          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            type="button"
            aria-label={t('kanban.downloadAttachment')}
            title={t('kanban.downloadAttachment')}
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const ImagePreviewDialog = defineModal<ImagePreviewDialogProps, void>(
  ImagePreviewDialogImpl
);
