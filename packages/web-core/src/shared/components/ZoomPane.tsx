import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@vibe/ui/lib/cn';

export type ZoomView = { s: number; x: number; y: number };

const MIN_SCALE = 1;
const MAX_SCALE = 8;

/** Scale by `k` about a viewport point; the untransformed content origin is (0, 0). */
export function zoomAbout(
  view: ZoomView,
  k: number,
  px: number,
  py: number
): ZoomView {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.s * k));
  const r = s / view.s;
  return { s, x: px * (1 - r) + r * view.x, y: py * (1 - r) + r * view.y };
}

/** Center content that fits the viewport; otherwise keep it covering the viewport. */
export function clampView(
  view: ZoomView,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
): ZoomView {
  const w = width * view.s;
  const h = height * view.s;
  return {
    s: view.s,
    x:
      w <= viewportWidth
        ? (viewportWidth - w) / 2
        : Math.min(0, Math.max(viewportWidth - w, view.x)),
    y:
      h <= viewportHeight
        ? (viewportHeight - h) / 2
        : Math.min(0, Math.max(viewportHeight - h, view.y)),
  };
}

// Pinch, drag, wheel and double-tap zoom for a single child. Pointer events
// plus touch-action:none work under the app-level pinch block (installAppZoom)
// and never zoom the page itself. Only a transform changes, so the browser
// re-rasters the child (image or iframe) at the final scale.
// ponytail: no inertia or rubber-banding; add if the viewer feels stiff.
export function ZoomPane({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let view: ZoomView = { s: 1, x: 0, y: 0 };
    const pointers = new Map<
      number,
      { x: number; y: number; startX: number; startY: number }
    >();
    let lastTap = 0;

    const render = (next: ZoomView) => {
      view = clampView(
        next,
        content.offsetWidth,
        content.offsetHeight,
        viewport.clientWidth,
        viewport.clientHeight
      );
      content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    };
    const local = (clientX: number, clientY: number) => {
      const rect = viewport.getBoundingClientRect();
      return [clientX - rect.left, clientY - rect.top] as const;
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      viewport.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
      });
    };
    const onMove = (event: PointerEvent) => {
      const prev = pointers.get(event.pointerId);
      if (!prev) return;
      const other = [...pointers.entries()].find(
        ([id]) => id !== event.pointerId
      )?.[1];
      const dx = event.clientX - prev.x;
      const dy = event.clientY - prev.y;
      if (other) {
        // Pinch: the midpoint moves by half of this pointer's delta, then the
        // content scales about the new midpoint.
        const before = Math.hypot(prev.x - other.x, prev.y - other.y) || 1;
        const after = Math.hypot(
          event.clientX - other.x,
          event.clientY - other.y
        );
        const [mx, my] = local(
          (event.clientX + other.x) / 2,
          (event.clientY + other.y) / 2
        );
        render(
          zoomAbout(
            { ...view, x: view.x + dx / 2, y: view.y + dy / 2 },
            after / before,
            mx,
            my
          )
        );
      } else if (pointers.size === 1) {
        render({ ...view, x: view.x + dx, y: view.y + dy });
      }
      pointers.set(event.pointerId, {
        ...prev,
        x: event.clientX,
        y: event.clientY,
      });
    };
    const onUp = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      pointers.delete(event.pointerId);
      const tap =
        event.type === 'pointerup' &&
        pointers.size === 0 &&
        Math.hypot(
          event.clientX - pointer.startX,
          event.clientY - pointer.startY
        ) < 12;
      if (!tap) {
        lastTap = 0;
        return;
      }
      if (event.timeStamp - lastTap < 300) {
        lastTap = 0;
        const [px, py] = local(event.clientX, event.clientY);
        render(zoomAbout(view, view.s > 1 ? 1 / view.s : 2.5, px, py));
      } else {
        lastTap = event.timeStamp;
      }
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const [px, py] = local(event.clientX, event.clientY);
      render(
        zoomAbout(
          view,
          Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)),
          px,
          py
        )
      );
    };

    // Re-fit when the child gets its size (image decode, diagram height) or
    // the viewport rotates.
    const observer = new ResizeObserver(() => render(view));
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener('pointerdown', onDown);
    viewport.addEventListener('pointermove', onMove);
    viewport.addEventListener('pointerup', onUp);
    viewport.addEventListener('pointercancel', onUp);
    // React registers wheel as passive; preventDefault needs a native listener.
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('pointerdown', onDown);
      viewport.removeEventListener('pointermove', onMove);
      viewport.removeEventListener('pointerup', onUp);
      viewport.removeEventListener('pointercancel', onUp);
      viewport.removeEventListener('wheel', onWheel);
    };
  }, []);

  return (
    <div
      ref={viewportRef}
      className={cn(
        'absolute inset-0 touch-none select-none overflow-hidden',
        className
      )}
    >
      <div ref={contentRef} className="absolute left-0 top-0 origin-top-left">
        {children}
      </div>
    </div>
  );
}
