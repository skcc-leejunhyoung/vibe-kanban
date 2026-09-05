// A second frame matters: its containing document's frame-src policy blocks
// self-navigation as well as nested frames. A single sandboxed srcdoc alone
// still lets arbitrary scripts navigate themselves to authenticated app URLs.
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export type PreviewResource = { path: string; mime: string; bytes: Uint8Array };

function dataUrl(mime: string, bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function buildArtifactPreview(
  source: string,
  path: string,
  resources: PreviewResource[],
  svg = false
): { srcDoc: string; warnings: string[] } {
  if (source.length > 2 * 1024 * 1024)
    throw new Error('Preview exceeds 2 MiB; use Source or Download.');
  const warnings = new Set<string>();
  const files = new Map(resources.map((resource) => [resource.path, resource]));
  const urls = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (reference: string, from: string): string => {
    if (reference.startsWith('#')) return reference;
    if (/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(reference))
      return reference;
    const target = new URL(reference, `https://artifact.invalid/${from}`);
    const relative = decodeURIComponent(target.pathname.slice(1));
    const resource = files.get(relative);
    if (
      target.origin !== 'https://artifact.invalid' ||
      !resource ||
      resolving.has(relative)
    ) {
      warnings.add(`Dependency unavailable: ${reference.slice(0, 160)}`);
      return 'data:,';
    }
    const existing = urls.get(relative);
    if (existing) return existing;
    resolving.add(relative);
    const bytes =
      resource.mime === 'text/css'
        ? new TextEncoder().encode(
            rewriteCss(new TextDecoder().decode(resource.bytes), relative)
          )
        : resource.bytes;
    const url = dataUrl(resource.mime, bytes);
    resolving.delete(relative);
    urls.set(relative, url);
    return url;
  };
  const rewriteCss = (css: string, from: string): string =>
    css.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi,
      (
        match,
        double: string,
        single: string,
        bare: string,
        importDouble: string,
        importSingle: string
      ) => {
        const target = resolve(
          double ?? single ?? bare ?? importDouble ?? importSingle,
          from
        );
        return match.startsWith('@')
          ? `@import url("${target}")`
          : `url("${target}")`;
      }
    );
  const doc = new DOMParser().parseFromString(source, 'text/html');
  doc
    .querySelectorAll(
      'base, meta[http-equiv], iframe, frame, frameset, object, embed'
    )
    .forEach((node) => node.remove());
  if (svg)
    doc
      .querySelectorAll('script, foreignObject')
      .forEach((node) => node.remove());
  doc.querySelectorAll('*').forEach((node) => {
    if (svg)
      for (const attribute of Array.from(node.attributes))
        if (attribute.name.toLowerCase().startsWith('on'))
          node.removeAttribute(attribute.name);
    for (const attribute of ['src', 'poster']) {
      const value = node.getAttribute(attribute);
      if (value) node.setAttribute(attribute, resolve(value, path));
    }
    for (const attribute of ['href', 'xlink:href']) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      if (node.tagName === 'A' || node.tagName === 'a') {
        if (!value.startsWith('#')) node.removeAttribute(attribute);
        node.removeAttribute('target');
      } else node.setAttribute(attribute, resolve(value, path));
    }
    if (node.hasAttribute('srcset')) {
      node.removeAttribute('srcset');
      warnings.add(
        'Responsive image sources require a development server preview.'
      );
    }
    const style = node.getAttribute('style');
    if (style) node.setAttribute('style', rewriteCss(style, path));
  });
  doc.querySelectorAll('style').forEach((node) => {
    node.textContent = rewriteCss(node.textContent ?? '', path);
  });
  const escape = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;');
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const escapeKey = doc.createElement('script');
  escapeKey.setAttribute('nonce', nonce);
  escapeKey.textContent = `addEventListener('keydown', e => { if (e.key === 'Escape') parent.postMessage('vibe:artifact:escape', '*'); }, true);
addEventListener('error', e => parent.postMessage({ type: 'vibe:artifact:error', message: String(e.message || 'Resource failed to load').slice(0, 500) }, '*'), true);
addEventListener('unhandledrejection', () => parent.postMessage({ type: 'vibe:artifact:error', message: 'An asynchronous script or dependency failed. Use Source or development server Preview.' }, '*'));`;
  doc.head.prepend(escapeKey);
  const policy = svg
    ? ARTIFACT_CSP.replace(
        "script-src 'unsafe-inline' data:",
        `script-src 'nonce-${nonce}'`
      )
    : ARTIFACT_CSP;
  const inner = `<!doctype html>${doc.documentElement.outerHTML}`;
  return {
    srcDoc: `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;display:block;background:white}</style><script nonce="${nonce}">addEventListener('message', e => { if (e.source !== document.querySelector('iframe')?.contentWindow) return; if (e.data === 'vibe:artifact:escape') parent.postMessage(e.data, '*'); else if (e.data?.type === 'vibe:artifact:error' && typeof e.data.message === 'string') parent.postMessage({ type: e.data.type, message: e.data.message.slice(0, 500) }, '*'); });</script><iframe title="Artifact document" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(inner)}"></iframe>`,
    warnings: [...warnings],
  };
}
