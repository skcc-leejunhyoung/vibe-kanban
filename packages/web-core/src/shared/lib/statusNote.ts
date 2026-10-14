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
      // CommonMark: a closing fence may carry trailing whitespace.
      const closing = run >= fence.count && delimiter.slice(run).trim() === '';
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
      // CommonMark: a backtick in a backtick fence's info string makes the
      // line inline code, not a fence.
      if (
        count >= 3 &&
        !(marker === '`' && delimiter.slice(count).includes('`'))
      ) {
        // CommonMark: the first word of the info string is the language.
        const status =
          delimiter.slice(count).trim().split(/\s+/)[0].toLowerCase() ===
          STATUS_INFO_STRING;
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

/** Upper bound on visible characters the server keeps. */
export const STATUS_MAX_VISIBLE_CHARS = 1000;

/**
 * Mirrors the server's cut: the first `max` visible characters, a link kept
 * whole or reduced to its (shortened) label, and an ellipsis when cut. The
 * client applies it so a streamed block equals the note the row will hold.
 */
export function statusTruncate(
  text: string,
  max = STATUS_MAX_VISIBLE_CHARS
): string {
  let out = '';
  let count = 0;
  let last = 0;
  let cut = false;
  const push = (slice: string) => {
    for (const ch of slice) {
      if (count === max) {
        cut = true;
        return false;
      }
      out += ch;
      count += 1;
    }
    return true;
  };
  for (const match of text.matchAll(LINK)) {
    const [whole, label] = match;
    const index = match.index ?? 0;
    if (!push(text.slice(last, index))) break;
    const labelLength = [...label].length;
    if (count + labelLength <= max) {
      out += whole;
      count += labelLength;
    } else {
      push(label);
      cut = true;
      break;
    }
    last = index + whole.length;
  }
  if (!cut) push(text.slice(last));
  return cut ? `${out.trimEnd()}…` : out;
}

/**
 * The summary a message currently ends with; a later block replaces an earlier
 * one and an empty block (a fence just opened) is skipped.
 */
export function extractLastStatusBlock(
  content: string
): { text: string; closed: boolean } | undefined {
  let last: { text: string; closed: boolean } | undefined;
  for (const segment of splitStatusSegments(content))
    if (segment.kind === 'status' && segment.text)
      last = { text: segment.text, closed: segment.closed };
  return last;
}

/** Link markup collapsed to its label: what the reader sees. */
export function statusPlainText(text: string): string {
  return text.replace(LINK, '$1');
}

// A period after a title, a reference abbreviation or initials never ends a
// sentence: "Dr. Kim", "Postgres vs. SQLite", "(e.g. Zustand)", "J. Kim".
// After "etc." or a company suffix it does when a capital letter follows.
// ponytail: when unsure, keep going; a longer headline is only clipped by the
// row, while a fragment like "Paired with J." reads as broken.
const NEVER_ENDS =
  /(?:^|[\s(])(?:dr|mr|mrs|prof|st|jr|sr|e\.g|i\.e|vs|cf|approx|fig|eq|ref|ch|sec|vol|pp|al)\.$/i;
const INITIALS = /(?:^|[\s(])(?:[A-Z]\.)+$/;
const ENDS_BEFORE_CAPITAL = /(?:^|[\s(])(?:etc|inc|ltd|co)\.$/i;

/**
 * The sentence the collapsed strip, sidebar row and issue card show. Ends at
 * the first terminal punctuation followed by whitespace (so "0.8초" never
 * cuts a sentence) or at a full-width stop, skipping abbreviations; a
 * summary without one is clipped to 80 characters.
 */
export function statusFirstSentence(text: string): string {
  const plain = statusPlainText(text).replace(/\s+/g, ' ').trim();
  const stops = /[.!?](?=\s|$)|[。！？]/g;
  let stop: RegExpExecArray | null;
  while ((stop = stops.exec(plain))) {
    const sentence = plain.slice(0, stop.index + 1);
    if (stop[0] === '.') {
      if (NEVER_ENDS.test(sentence) || INITIALS.test(sentence)) continue;
      const next = plain
        .slice(stop.index + 1)
        .trimStart()
        .charAt(0);
      if (
        next !== '' &&
        !/[A-Z]/.test(next) &&
        ENDS_BEFORE_CAPITAL.test(sentence)
      )
        continue;
    }
    return sentence;
  }
  const chars = Array.from(plain);
  return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : plain;
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
