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
import { $handleListItemBackspace } from '@vibe/ui/components/ListBackspacePlugin';
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
