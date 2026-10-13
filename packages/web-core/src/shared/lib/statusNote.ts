import type { StatusToken } from '@vibe/ui/components/WorkspaceStatusStrip';

/**
 * The agent's live workspace summary: a fenced block tagged `vibe-status` in
 * an assistant message. Mirrors executors::logs::status_note so the chat hides
 * exactly the blocks the server stores on the workspace row.
 */
export const STATUS_INFO_STRING = 'vibe-status';

export type StatusSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'status'; text: string; closed: boolean };

// A markdown link: label, then <target> or bare target, then an optional title.
const LINK =
  /\[([^\]\n]*)\]\(\s*(?:<([^>\n]*)>|([^\s)]+))(?:\s+"([^"\n]*)")?\s*\)/g;

/**
 * Splits a message into markdown runs and summary blocks. Every fence is
 * tracked, so a `vibe-status` example quoted inside another code block stays
 * ordinary markdown. An unterminated block is reported with `closed: false`.
 */
export function splitStatusSegments(content: string): StatusSegment[] {
  const segments: StatusSegment[] = [];
  let markdown: string[] = [];
  const flush = () => {
    if (markdown.join('\n').trim())
      segments.push({ kind: 'markdown', text: markdown.join('\n') });
    markdown = [];
  };
  let fence: {
    marker: string;
    count: number;
    status: boolean;
    lines: string[];
  } | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    // Markdown allows up to three leading spaces on fence delimiters.
    const delimiter = line.startsWith('    ') ? line : line.replace(/^ +/, '');
    if (fence) {
      let run = 0;
      while (delimiter[run] === fence.marker) run++;
      const closing =
        run >= fence.count &&
        delimiter.replace(new RegExp(`\\${fence.marker}+$`), '').trim() === '';
      if (fence.status) {
        if (closing) {
          flush();
          segments.push({
            kind: 'status',
            text: fence.lines.join('\n').trim(),
            closed: true,
          });
          fence = null;
        } else fence.lines.push(line);
      } else {
        markdown.push(line);
        if (closing) fence = null;
      }
      continue;
    }
    const marker = delimiter[0];
    if (marker === '`' || marker === '~') {
      let count = 0;
      while (delimiter[count] === marker) count++;
      if (count >= 3) {
        const status =
          delimiter.slice(count).trim().toLowerCase() === STATUS_INFO_STRING;
        fence = { marker, count, status, lines: [] };
        if (!status) markdown.push(line);
        continue;
      }
    }
    markdown.push(line);
  }
  if (fence?.status) {
    flush();
    segments.push({
      kind: 'status',
      text: fence.lines.join('\n').trim(),
      closed: false,
    });
  } else flush();
  return segments;
}

/** The summary a message currently ends with; a later block replaces an earlier one. */
export function extractLastStatusBlock(
  content: string
): { text: string; closed: boolean } | undefined {
  let last: { text: string; closed: boolean } | undefined;
  for (const segment of splitStatusSegments(content))
    if (segment.kind === 'status')
      last = { text: segment.text, closed: segment.closed };
  return last;
}

/** Link markup collapsed to its label: what the reader sees. */
export function statusPlainText(text: string): string {
  return text.replace(LINK, '$1');
}

/**
 * The sentence the collapsed strip, sidebar row and issue card show. Ends at
 * the first terminal punctuation followed by whitespace (so "0.8초" never
 * cuts a sentence) or at a full-width stop; a summary without one is clipped
 * to 80 characters.
 */
export function statusFirstSentence(text: string): string {
  const plain = statusPlainText(text).replace(/\s+/g, ' ').trim();
  const match = plain.match(/^(.+?(?:[.!?](?=\s|$)|[。！？]))/);
  if (match) return match[1];
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}

/**
 * Paragraphs (split on blank lines) as text and link tokens. Only links are
 * rendered specially; the summary is prose, not markdown.
 */
export function statusParagraphs(text: string): StatusToken[][] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map(tokenize);
}

function tokenize(paragraph: string): StatusToken[] {
  const tokens: StatusToken[] = [];
  let last = 0;
  for (const match of paragraph.matchAll(LINK)) {
    const [whole, label, angled, bare, title] = match;
    const index = match.index ?? 0;
    if (index > last)
      tokens.push({ kind: 'text', text: paragraph.slice(last, index) });
    tokens.push({
      kind: 'link',
      label,
      target: (angled ?? bare ?? '').trim(),
      artifact: title === 'vibe-artifact',
    });
    last = index + whole.length;
  }
  if (last < paragraph.length)
    tokens.push({ kind: 'text', text: paragraph.slice(last) });
  return tokens;
}
