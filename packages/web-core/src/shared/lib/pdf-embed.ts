type PdfNavigator = {
  userAgent: string;
  maxTouchPoints: number;
  pdfViewerEnabled?: boolean;
};

/**
 * WebKit paints only the first page of a PDF embedded in an iframe and gives it
 * no scrollbar, so iOS has to fall back to a canvas renderer. Every browser on
 * iOS/iPadOS runs WebKit, and iPadOS reports a desktop Mac agent that touch
 * points separate from a real Mac.
 */
export function canEmbedPdf(nav: PdfNavigator = navigator): boolean {
  // Set when a desktop browser is configured to download PDFs instead.
  if (nav.pdfViewerEnabled === false) return false;
  const ios =
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
  return !ios;
}
