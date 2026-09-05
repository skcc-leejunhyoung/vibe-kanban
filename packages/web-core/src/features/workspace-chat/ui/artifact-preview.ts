import { dataUrl, isolatePreviewDocument } from '@/shared/lib/isolatedPreview';
import type { ArtifactReference } from 'shared/types';

// A tool can return both a file link and the same image as base64. Preserve
// both references for replay, but show the named file instead of its Vibe copy.
export function deduplicateManagedImages(artifacts: ArtifactReference[]) {
  const isCopy = (artifact: ArtifactReference) => {
    const parts = artifact.path?.split('/');
    return (
      !!artifact.content_hash &&
      artifact.mime.startsWith('image/') &&
      parts?.at(-2) === '.vibe-attachments' &&
      !!parts.at(-1)?.startsWith(`agent-${artifact.content_hash.slice(0, 16)}.`)
    );
  };
  const key = (artifact: ArtifactReference) =>
    JSON.stringify([
      artifact.execution_id,
      artifact.source_scope,
      artifact.source_entry,
      artifact.mime,
      artifact.content_hash,
    ]);
  const originals = new Set(
    artifacts
      .filter(
        (artifact) =>
          artifact.path && artifact.content_hash && !isCopy(artifact)
      )
      .map(key)
  );
  return artifacts.filter(
    (artifact) => !isCopy(artifact) || !originals.has(key(artifact))
  );
}

export { ARTIFACT_CSP } from '@/shared/lib/isolatedPreview';

export type PreviewResource = { path: string; mime: string; bytes: Uint8Array };

export function buildArtifactPreview(
  source: string,
  path: string,
  resources: PreviewResource[],
  svg = false
): { srcDoc: string; warnings: string[] } {
  if (source.length > 2 * 1024 * 1024)
    throw new Error('Preview exceeds 2 MiB; use Source or Download.');
  if (svg) {
    const document = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (
      document.querySelector('parsererror') ||
      document.documentElement.localName !== 'svg'
    )
      throw new Error('Invalid SVG document; use Source or Download.');
  }
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
  return { srcDoc: isolatePreviewDocument(doc, svg), warnings: [...warnings] };
}
