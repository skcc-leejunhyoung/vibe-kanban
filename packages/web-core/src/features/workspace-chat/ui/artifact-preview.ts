import { dataUrl, isolatePreviewDocument } from '@/shared/lib/isolatedPreview';
import type { ArtifactReference, SubagentControlTarget } from 'shared/types';

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

export type InlinePreviewKind =
  | 'image'
  | 'frame'
  | 'mermaid'
  | 'pdf'
  | 'office';

export function isOfficeMime(mime: string) {
  return (
    mime.startsWith('application/vnd.openxmlformats-officedocument.') ||
    mime.startsWith('application/vnd.oasis.opendocument.') ||
    [
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      // Kept in sync with services::artifacts::is_office.
      'application/rtf',
      'text/rtf',
    ].includes(mime)
  );
}

/** Ready snapshots the chat can show as a thumbnail; everything else stays a card. */
export function inlinePreviewKind(
  artifact: ArtifactReference
): InlinePreviewKind | null {
  if (artifact.url || !artifact.content_hash || artifact.status !== 'ready')
    return null;
  const { mime } = artifact;
  if (
    /^image\/(png|jpeg|gif|webp|bmp|x-icon|vnd.microsoft.icon|tiff)$/.test(mime)
  )
    return 'image';
  if (mime === 'text/html' || mime === 'image/svg+xml') return 'frame';
  if (mime === 'text/vnd.mermaid') return 'mermaid';
  if (mime === 'application/pdf') return 'pdf';
  if (isOfficeMime(mime)) return 'office';
  return null;
}

/** Mirrors services::subagent_transcript::scope for child-owned artifacts. */
export function subagentScope(target: SubagentControlTarget) {
  return target.executor === 'codex'
    ? `codex:${target.thread_id}`
    : `claude:${target.task_id}`;
}

export type ArtifactSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'file'; raw: string; path: string }
  | { kind: 'url'; raw: string; url: string }
  | { kind: 'inline'; raw: string; name: string };

// Same standalone-line rule as executors::logs::artifacts::LINK.
const ARTIFACT_LINK =
  /^(?:[-+*] |[0-9]+[.)] )?!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))\s+"vibe-artifact"\s*\)$/;
const FILE_LINE = /(?::[0-9]+){1,2}$/;

function svgRoot(source: string) {
  const trimmed = source.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed.startsWith('<?xml')) return trimmed;
  const end = trimmed.indexOf('?>');
  return end === -1 ? trimmed : trimmed.slice(end + 2).trimStart();
}

// Mirrors the backend's inline candidate rules: only complete documents are
// registered, so only those are rendered in place of their fence.
function inlineExtension(language: string, source: string) {
  const lower = source.toLowerCase();
  switch (language) {
    case 'mermaid':
      return 'mmd';
    case 'html':
    case 'htm':
      return (lower.startsWith('<!doctype html') ||
        lower.startsWith('<html')) &&
        lower.endsWith('</html>')
        ? 'html'
        : null;
    case 'svg':
    case 'xml': {
      const root = svgRoot(lower);
      return root.startsWith('<svg') &&
        (lower.endsWith('</svg>') ||
          (root.endsWith('/>') && !root.slice(0, -2).includes('>')))
        ? 'svg'
        : null;
    }
    default:
      return null;
  }
}

/**
 * Splits a message at the lines the backend registers as artifacts
 * (executors::logs::artifacts::markdown_candidates) so previews can render in
 * place. Mermaid fences stay markdown: the editor already renders them.
 */
export function splitArtifactSegments(content: string): ArtifactSegment[] {
  const segments: ArtifactSegment[] = [];
  let markdown: string[] = [];
  const flush = () => {
    // Blank runs around previews would only render empty editors.
    if (markdown.join('\n').trim())
      segments.push({ kind: 'markdown', text: markdown.join('\n') });
    markdown = [];
  };
  let fence: {
    marker: string;
    count: number;
    language: string;
    lines: string[];
  } | null = null;
  let ordinal = 0;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    // Markdown allows up to three leading spaces on fence delimiters.
    const delimiter = line.startsWith('    ') ? line : line.replace(/^ +/, '');
    if (fence) {
      const { marker } = fence;
      let run = 0;
      while (delimiter[run] === marker) run++;
      const closing =
        run >= fence.count &&
        delimiter.replace(new RegExp(`\\${marker}+$`), '').trim() === '';
      if (!closing) {
        fence.lines.push(line);
        continue;
      }
      const source = fence.lines.slice(1).join('\n').trim();
      const extension = source ? inlineExtension(fence.language, source) : null;
      if (extension && extension !== 'mmd') {
        flush();
        segments.push({
          kind: 'inline',
          raw: [...fence.lines, line].join('\n'),
          name: `block-${ordinal}.${extension}`,
        });
      } else markdown.push(...fence.lines, line);
      ordinal += 1;
      fence = null;
      continue;
    }
    const marker = delimiter[0];
    if (marker === '`' || marker === '~') {
      let count = 0;
      while (delimiter[count] === marker) count++;
      if (count >= 3) {
        const info = delimiter.slice(count).trim();
        fence = {
          marker,
          count,
          language: info.endsWith(' vibe-artifact')
            ? info.slice(0, -' vibe-artifact'.length).toLowerCase()
            : '',
          lines: [line],
        };
        continue;
      }
    }
    if (
      line.trimStart().startsWith('>') ||
      line.startsWith('    ') ||
      line.startsWith('\t')
    ) {
      markdown.push(line);
      continue;
    }
    const match = ARTIFACT_LINK.exec(line.trim());
    const target = match?.[1] ?? match?.[2];
    if (target && /^https?:\/\//.test(target)) {
      flush();
      segments.push({ kind: 'url', raw: line, url: target });
      continue;
    }
    if (
      target &&
      !target.includes('://') &&
      !target.startsWith('#') &&
      !target.startsWith('data:')
    ) {
      const reference = target.split(/[#?]/)[0].replace(FILE_LINE, '');
      let path: string | undefined;
      try {
        path = decodeURIComponent(reference);
      } catch {
        path = undefined;
      }
      if (path) {
        flush();
        segments.push({ kind: 'file', raw: line, path });
        continue;
      }
    }
    markdown.push(line);
  }
  if (fence) markdown.push(...fence.lines);
  flush();
  return segments;
}

/**
 * The registered artifact a segment stands for, if the execution has one.
 * Inline block names restart in every message, so fences only match `owned`,
 * the artifacts bound to this entry. File and URL ids are execution-wide.
 */
export function findSegmentArtifact(
  segment: ArtifactSegment,
  artifacts: ArtifactReference[],
  owned: ArtifactReference[]
): ArtifactReference | undefined {
  if (segment.kind === 'markdown') return undefined;
  if (segment.kind === 'url')
    return artifacts.find((artifact) => artifact.url === segment.url);
  if (segment.kind === 'inline')
    return owned.find(
      (artifact) => artifact.path === null && artifact.name === segment.name
    );
  // Registered paths are workspace-relative; links are relative to the agent's
  // working directory or absolute. Among files sharing a name the closest
  // suffix match wins.
  const path = segment.path.replace(/^(\.\/)+/, '');
  let best: ArtifactReference | undefined;
  let bestDistance = Infinity;
  for (const artifact of artifacts) {
    const candidate = artifact.path;
    if (
      !candidate ||
      !(
        candidate === path ||
        candidate.endsWith(`/${path}`) ||
        path.endsWith(`/${candidate}`)
      )
    )
      continue;
    const distance = Math.abs(candidate.length - path.length);
    if (distance < bestDistance) {
      best = artifact;
      bestDistance = distance;
    }
  }
  return best;
}
