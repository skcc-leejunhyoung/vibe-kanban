// pdf.js needs its built-in CMaps to draw CJK fonts a PDF does not embed (for
// example reportlab's UnicodeCIDFont); without them that text renders blank.
// Only PdfPages imports this, lazily, so the app bundle does not carry it.
const cmaps: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
      eager: true,
      query: '?url&no-inline',
      import: 'default',
    })
  ).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url])
);

/** pdf.js `BinaryDataFactory` that serves CMaps from the app's own assets. */
export class BundledBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const url = kind === 'cMapUrl' ? cmaps[filename] : undefined;
    if (!url) throw new Error(`No bundled ${kind} data: ${filename}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} loading ${filename}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
