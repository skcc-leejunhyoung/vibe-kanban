import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createListNode, $isListItemNode, $isListNode } from '@lexical/list';
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  DELETE_CHARACTER_COMMAND,
} from 'lexical';

/**
 * Backspace at the start of a list item. Nested items outdent; top-level
 * items become a paragraph in place (the list is split around them). Lexical's
 * default merges the item into the previous line, which drops the line break
 * together with the bullet/checkbox.
 */
export function $handleListItemBackspace(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }
  const { anchor } = selection;
  const node = anchor.getNode();
  const listItem = $isListItemNode(node)
    ? node
    : node.getParents().find($isListItemNode);
  const list = listItem?.getParent();
  if (
    !listItem ||
    !$isListNode(list) ||
    anchor.offset !== 0 ||
    // Wrapper item holding a nested list; the caret never belongs here.
    $isListNode(listItem.getFirstChild()) ||
    !(node.is(listItem) || node.is(listItem.getFirstDescendant()))
  ) {
    return false;
  }

  const indent = listItem.getIndent();
  if (indent > 0) {
    listItem.setIndent(indent - 1);
    return true;
  }

  const paragraph = $createParagraphNode().append(...listItem.getChildren());
  const rest = listItem.getNextSiblings();
  if (listItem.getPreviousSibling() === null) {
    list.insertBefore(paragraph);
  } else {
    list.insertAfter(paragraph);
    if (rest.length > 0) {
      paragraph.insertAfter(
        $createListNode(list.getListType()).append(...rest)
      );
    }
  }
  // A ListNode cannot be empty, so Lexical drops it when this was its last item.
  listItem.remove();
  paragraph.select(0, 0);
  return true;
}

export function ListBackspacePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      // DELETE_CHARACTER_COMMAND rather than KEY_BACKSPACE_COMMAND: Safari and
      // iOS Korean reach deletion through beforeinput, which skips the keydown
      // command (see ImeDeleteGuardPlugin).
      editor.registerCommand(
        DELETE_CHARACTER_COMMAND,
        (isBackward) => isBackward && $handleListItemBackspace(),
        COMMAND_PRIORITY_LOW
      ),
    [editor]
  );

  return null;
}
