import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import { $canOutdentSelection } from './WYSIWYGEditor';

function canOutdentAt(target: 'paragraph' | 'top' | 'nested') {
  const editor = createEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error;
    },
  });
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
