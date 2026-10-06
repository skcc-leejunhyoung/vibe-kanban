import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import { CHECK_LIST, TRANSFORMERS } from '@lexical/markdown';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { $handleListItemBackspace } from '@vibe/ui/components/ListBackspacePlugin';
import { $editorToMarkdown, $markdownToEditor } from '@vibe/ui/lib/markdown';
import { TABLE_TRANSFORMER } from '@vibe/ui/lib/table-transformer';
import { $canOutdentSelection } from './WYSIWYGEditor';

const newEditor = () =>
  createEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error;
    },
  });

function canOutdentAt(target: 'paragraph' | 'top' | 'nested') {
  const editor = newEditor();
  let result = false;
  editor.update(
    () => {
      const paragraph = $createTextNode('p');
      const top = $createTextNode('a');
      const nested = $createTextNode('b');
      const nestedItem = $createListItemNode().append(nested);
      $getRoot().append(
        $createParagraphNode().append(paragraph),
        $createListNode('bullet').append(
          $createListItemNode().append(top),
          nestedItem
        )
      );
      nestedItem.setIndent(1);
      ({ paragraph, top, nested })[target].select();
      result = $canOutdentSelection();
    },
    { discrete: true }
  );
  return result;
}

describe('$canOutdentSelection', () => {
  it('outdents only nested list items', () => {
    expect(canOutdentAt('nested')).toBe(true);
    expect(canOutdentAt('top')).toBe(false);
    expect(canOutdentAt('paragraph')).toBe(false);
  });
});

/** Compact outline of the root: `ul(a,b) p(c)`; nested lists render inline. */
function outline(node: LexicalNode): string {
  if ($isListNode(node)) {
    const items = node
      .getChildren()
      .map(
        (item) =>
          item.getChildren().map(outline).join('') || item.getTextContent()
      );
    return `${node.getTag()}(${items.join(',')})`;
  }
  return node.getType() === 'paragraph'
    ? `p(${node.getTextContent()})`
    : node.getTextContent();
}

/** Backspace with the caret at `offset` inside list item `target` of a,b,c. */
function backspaceIn(
  target: 'a' | 'b' | 'c',
  offset = 0,
  { nestB = false, leadingParagraph = false } = {}
) {
  const editor = newEditor();
  let handled = false;
  let result = '';
  editor.update(
    () => {
      const texts = {
        a: $createTextNode('a'),
        b: $createTextNode('b'),
        c: $createTextNode('c'),
      };
      const itemB = $createListItemNode().append(texts.b);
      if (leadingParagraph) {
        $getRoot().append($createParagraphNode().append($createTextNode('x')));
      }
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append(texts.a),
          itemB,
          $createListItemNode().append(texts.c)
        )
      );
      if (nestB) itemB.setIndent(1);
      texts[target].select(offset, offset);
      handled = $handleListItemBackspace();
      result = $getRoot().getChildren().map(outline).join(' ');
    },
    { discrete: true }
  );
  return { handled, result };
}

describe('$handleListItemBackspace', () => {
  it('turns a top-level item into a paragraph in place', () => {
    expect(backspaceIn('b')).toEqual({
      handled: true,
      result: 'ul(a) p(b) ul(c)',
    });
    expect(backspaceIn('a', 0, { leadingParagraph: true })).toEqual({
      handled: true,
      result: 'p(x) p(a) ul(b,c)',
    });
    expect(backspaceIn('c')).toEqual({ handled: true, result: 'ul(a,b) p(c)' });
  });

  it('outdents a nested item first', () => {
    expect(backspaceIn('b', 0, { nestB: true })).toEqual({
      handled: true,
      result: 'ul(a,b,c)',
    });
  });

  it('leaves the caret mid-item to the default deletion', () => {
    expect(backspaceIn('b', 1)).toEqual({
      handled: false,
      result: 'ul(a,b,c)',
    });
  });
});

/** The editor's transformer order: custom element transformers first. */
const EDITOR_TRANSFORMERS = [TABLE_TRANSFORMER, CHECK_LIST, ...TRANSFORMERS];

const markdownEditor = () =>
  createEditor({
    nodes: [
      ListNode,
      ListItemNode,
      HeadingNode,
      QuoteNode,
      CodeNode,
      LinkNode,
      TableNode,
      TableRowNode,
      TableCellNode,
    ],
    onError: (error) => {
      throw error;
    },
  });

/** Import `markdown` into a fresh editor and export it again. */
function roundTrip(markdown: string) {
  const editor = markdownEditor();
  let blocks = 0;
  let exported = '';
  editor.update(
    () => {
      $markdownToEditor(markdown, EDITOR_TRANSFORMERS);
      blocks = $getRoot().getChildrenSize();
      exported = $editorToMarkdown(EDITOR_TRANSFORMERS);
    },
    { discrete: true }
  );
  return { blocks, exported };
}

/** Export a paragraph holding one text node with `format` applied. */
function exportFormatted(text: string, format: 'bold' | 'italic' | 'code') {
  const editor = markdownEditor();
  let exported = '';
  editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode(text).toggleFormat(format)
        )
      );
      exported = $editorToMarkdown(EDITOR_TRANSFORMERS);
    },
    { discrete: true }
  );
  return exported;
}

describe('markdown round trip', () => {
  it('keeps blank lines and single newlines as typed', () => {
    const markdown =
      'a\n\n\nb\nc\n\n- d\n- e\n\nf\n\n> q\n\n```\ncode\n\n\nmore\n```';
    expect(roundTrip(markdown)).toEqual({ blocks: 13, exported: markdown });
  });

  it('does not merge adjacent lines into one paragraph', () => {
    expect(roundTrip('a\nb')).toEqual({ blocks: 2, exported: 'a\nb' });
  });

  it.each([
    'my_var and other_var',
    'C:\\Users\\me and "C:\\\\p" in json',
    '2 * 3 * 4 and ** b **',
    'https://ex.com/a_b_c?x=1_2',
    'a \\* b \\_ c \\\\ d',
    '/^\\d+$/ and ~1 and a ` b',
    '`a\\_b` and `\\\\` and `x*y`',
    'a \\* b **c** and [a_b](http://x) and \\_ *i*',
    '```\na\\*b \\\\ c\n```',
    '~~~\nnot a fence here\n~~~',
  ])('does not add or drop backslashes: %s', (markdown) => {
    expect(roundTrip(markdown).exported).toBe(markdown);
  });

  it('still reads real formatting', () => {
    expect(roundTrip('**b** *i* ~~s~~ `c` [l](http://x)')).toMatchObject({
      exported: '**b** *i* ~~s~~ `c` [l](http://x)',
    });
  });

  it('moves edge whitespace of formatted text outside the markers', () => {
    expect(exportFormatted(' b ', 'bold')).toBe(' **b** ');
    expect(exportFormatted('i ', 'italic')).toBe('*i* ');
    expect(exportFormatted(' c', 'code')).toBe('` c`');
  });

  it('keeps [X] checked and 2-space nesting', () => {
    expect(roundTrip('- [X] done\n- [ ] todo').exported).toBe(
      '- [x] done\n- [ ] todo'
    );
    expect(roundTrip('- a\n  - b\n    - c\n  - d\n- e').exported).toBe(
      '- a\n    - b\n        - c\n    - d\n- e'
    );
    expect(roundTrip('* a\n   * b').exported).toBe('- a\n    - b');
    expect(roundTrip('1. a\n   1. b\n\n    - c').exported).toBe(
      '1. a\n    1. b\n\n    - c'
    );
  });

  it.each([
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '| a |  | c |\n| --- | --- | --- |\n| 1 |  | 3 |',
  ])('keeps tables stable: %s', (markdown) => {
    const once = roundTrip(markdown).exported;
    expect(once).toBe(markdown);
    expect(roundTrip(once).exported).toBe(markdown);
  });
});
