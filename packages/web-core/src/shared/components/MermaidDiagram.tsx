import { useEffect, useState, useRef } from 'react';
import { dataUrl, isolatePreviewDocument } from '@/shared/lib/isolatedPreview';

interface MermaidDiagramProps {
  chart: string;
  theme: 'light' | 'dark';
}

// Serialize all mermaid operations to avoid concurrent render/initialize races
let mermaidQueue: Promise<void> = Promise.resolve();
let initializedTheme: string | null = null;

export function MermaidDiagram({
  isolated = false,
  ...props
}: MermaidDiagramProps & { isolated?: boolean }) {
  return isolated ? (
    <IsolatedMermaidDiagram {...props} />
  ) : (
    <InlineMermaidDiagram {...props} />
  );
}

// Mermaid loads image nodes while rendering, before its SVG is sanitized.
// Artifact diagrams must run the renderer itself behind the preview CSP.
function IsolatedMermaidDiagram({ chart, theme }: MermaidDiagramProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [srcDoc, setSrcDoc] = useState<string>();
  const [height, setHeight] = useState(160);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setSrcDoc(undefined);
    setError(undefined);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'vibe:artifact:error')
        setError(String(event.data.message));
      if (
        event.data?.type === 'vibe:artifact:resize' &&
        Number.isFinite(event.data.height)
      )
        setHeight(Math.max(80, Math.min(10000, event.data.height)));
      if (event.data === 'vibe:artifact:escape')
        frame.current?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
    };
    window.addEventListener('message', onMessage);
    void import('mermaid/dist/mermaid.min.js?raw')
      .then(({ default: code }) => {
        if (cancelled) return;
        const doc = new DOMParser().parseFromString(
          '<!doctype html><html><head><style>body{margin:0}svg{display:block}</style></head><body><div id="diagram"></div></body></html>',
          'text/html'
        );
        const library = doc.createElement('script');
        library.src = dataUrl(
          'text/javascript',
          new TextEncoder().encode(code)
        );
        doc.body.append(library);
        const render = doc.createElement('script');
        const input = JSON.stringify({
          chart,
          theme: theme === 'dark' ? 'dark' : 'default',
        }).replaceAll('<', '\\u003c');
        render.textContent = `(async () => {
        const input = ${input};
        try {
          mermaid.initialize({ startOnLoad: false, theme: input.theme, securityLevel: 'strict' });
          const { svg } = await mermaid.render('diagram-svg', input.chart);
          const root = document.getElementById('diagram');
          root.innerHTML = svg;
          new ResizeObserver(() => parent.postMessage({ type: 'vibe:artifact:resize', height: Math.ceil(root.getBoundingClientRect().height) }, '*')).observe(root);
        } catch (error) {
          parent.postMessage({ type: 'vibe:artifact:error', message: String(error).slice(0, 500) }, '*');
        }
      })();`;
        doc.body.append(render);
        setSrcDoc(isolatePreviewDocument(doc));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
      window.removeEventListener('message', onMessage);
    };
  }, [chart, theme]);
  if (error)
    return (
      <div className="rounded-sm border border-error/20 bg-error/5 p-base">
        <p className="text-xs text-error mb-2">Mermaid diagram error</p>
        <pre className="text-xs text-low overflow-auto">
          <code>{chart}</code>
        </pre>
      </div>
    );
  if (!srcDoc) return <p className="text-low">Loading diagram…</p>;
  return (
    <iframe
      ref={frame}
      title="Mermaid diagram"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height }}
      className="w-full border-0"
    />
  );
}

function InlineMermaidDiagram({ chart, theme }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const renderCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const renderId = ++renderCountRef.current;

    mermaidQueue = mermaidQueue.then(async () => {
      if (cancelled) return;

      try {
        const { default: mermaid } = await import('mermaid');
        const mermaidTheme = theme === 'dark' ? 'dark' : 'default';

        if (initializedTheme !== mermaidTheme) {
          mermaid.initialize({
            startOnLoad: false,
            theme: mermaidTheme,
            securityLevel: 'strict',
          });
          initializedTheme = mermaidTheme;
        }

        // Use renderId to ensure each render call gets a unique DOM element ID
        const { svg: renderedSvg } = await mermaid.render(
          `mermaid-${renderId}-${Date.now()}`,
          chart
        );

        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to render diagram'
          );
          setSvg('');
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chart, theme]);

  if (error) {
    return (
      <div className="rounded-sm border border-error/20 bg-error/5 p-base">
        <p className="text-xs text-error mb-2">Mermaid diagram error</p>
        <pre className="text-xs text-low overflow-auto">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="flex items-center justify-center p-base text-low text-sm">
        Loading diagram…
      </div>
    );
  }

  return (
    <div
      className="my-3 flex justify-center overflow-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
