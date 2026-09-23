import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist';

// Rendering above this stops helping and starts costing phone memory.
const MAX_PIXEL_RATIO = 2;
// Pages within this much of the viewport hold a canvas; the rest release it.
const PRELOAD_MARGIN = '200% 0px';

type WithResolvers = { withResolvers?: unknown };

// pdf.js calls Promise.withResolvers, which WebKit only shipped in 17.4 — and
// WebKit is the engine this whole fallback exists for.
function polyfillWithResolvers() {
  const ctor = Promise as unknown as WithResolvers;
  if (typeof ctor.withResolvers === 'function') return;
  ctor.withResolvers = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
}

let library: Promise<typeof import('pdfjs-dist')> | undefined;

// Loaded on demand so browsers with a working embedded viewer never pay for it.
function loadPdfjs() {
  library ??= (async () => {
    polyfillWithResolvers();
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })().catch((error) => {
    // A transient failure must not poison every later open.
    library = undefined;
    throw error;
  });
  return library;
}

/**
 * Scrollable page-by-page render of a PDF, for engines that cannot show one in
 * an iframe. Pages draw as they approach the viewport and drop their canvas
 * once they leave, so a long document does not grow without bound.
 */
export function PdfPages({ blob, title }: { blob: Blob; title: string }) {
  const { t } = useTranslation('common');
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | undefined;
    let document_: PDFDocumentProxy | undefined;
    let observer: IntersectionObserver | undefined;
    const tasks = new Map<Element, RenderTask>();

    const run = async () => {
      const pdfjs = await loadPdfjs();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      loading = pdfjs.getDocument({ data: bytes });
      document_ = await loading.promise;
      if (cancelled) return;
      const numbers = new Map<Element, number>();
      // A frame can re-enter the viewport while its first draw is still
      // awaiting, which would stack a second canvas on top of the first.
      const drawing = new Set<Element>();

      const draw = async (frame: HTMLElement, number: number) => {
        if (!document_ || drawing.has(frame) || frame.firstElementChild) return;
        drawing.add(frame);
        try {
          await paint(frame, number);
        } finally {
          drawing.delete(frame);
        }
      };

      const paint = async (frame: HTMLElement, number: number) => {
        if (!document_) return;
        const page = await document_.getPage(number);
        if (cancelled || frame.firstElementChild) return;
        const unscaled = page.getViewport({ scale: 1 });
        const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        const width = (frame.clientWidth || unscaled.width) * ratio;
        const viewport = page.getViewport({ scale: width / unscaled.width });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.className = 'block h-full w-full';
        const context = canvas.getContext('2d');
        if (!context) return;
        frame.append(canvas);
        const task = page.render({ canvas, canvasContext: context, viewport });
        tasks.set(frame, task);
        try {
          await task.promise;
        } catch {
          // Cancelled by a fast scroll; the frame is free to draw again.
          canvas.remove();
        } finally {
          tasks.delete(frame);
          page.cleanup();
        }
      };

      const release = (frame: HTMLElement) => {
        tasks.get(frame)?.cancel();
        frame.firstElementChild?.remove();
      };

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const number = numbers.get(entry.target);
            if (!number) continue;
            const frame = entry.target as HTMLElement;
            if (entry.isIntersecting) void draw(frame, number);
            else release(frame);
          }
        },
        { root: host, rootMargin: PRELOAD_MARGIN }
      );

      for (let number = 1; number <= document_.numPages; number += 1) {
        const page = await document_.getPage(number);
        if (cancelled) return;
        const { width, height } = page.getViewport({ scale: 1 });
        page.cleanup();
        const frame = document.createElement('div');
        frame.className = 'mx-auto my-2 w-full max-w-[900px] bg-white';
        frame.style.aspectRatio = `${width} / ${height}`;
        host.append(frame);
        numbers.set(frame, number);
        observer.observe(frame);
      }
      setPending(false);
    };

    run().catch((cause) => {
      if (cancelled) return;
      setPending(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      for (const task of tasks.values()) task.cancel();
      host.replaceChildren();
      // The loading task owns the worker; destroying it tears the document down.
      void loading?.destroy();
    };
  }, [blob]);

  return (
    <div className="relative h-full">
      <div
        ref={hostRef}
        className="h-full overflow-auto overscroll-contain px-2"
        aria-label={title}
      />
      {(pending || error) && (
        <p
          role={error ? 'alert' : 'status'}
          className="absolute inset-x-0 top-1/2 px-4 text-center text-xs text-white/70"
        >
          {error ?? t('artifacts.loading')}
        </p>
      )}
    </div>
  );
}
