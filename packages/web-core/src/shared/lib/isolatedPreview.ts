// A second frame matters: its containing document's frame-src policy blocks
// self-navigation as well as nested frames. A single sandboxed srcdoc alone
// still lets arbitrary scripts navigate themselves to authenticated app URLs.
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function dataUrl(mime: string, bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function isolatePreviewDocument(doc: Document, svg = false): string {
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
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;display:block;background:white}</style><script nonce="${nonce}">addEventListener('message', e => { if (e.source !== document.querySelector('iframe')?.contentWindow) return; if (e.data === 'vibe:artifact:escape') parent.postMessage(e.data, '*'); else if (e.data?.type === 'vibe:artifact:error' && typeof e.data.message === 'string') parent.postMessage({ type: e.data.type, message: e.data.message.slice(0, 500) }, '*'); else if (e.data?.type === 'vibe:artifact:resize' && Number.isFinite(e.data.height)) parent.postMessage({ type: e.data.type, height: Math.max(0, Math.min(10000, e.data.height)) }, '*'); });</script><iframe title="Artifact document" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(inner)}"></iframe>`;
}
