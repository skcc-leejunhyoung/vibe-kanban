import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isElementNode,
  $isTextNode,
  $isDecoratorNode,
  $isLineBreakNode,
  $getCharacterOffsets,
  COPY_COMMAND,
  CUT_COMMAND,
  COMMAND_PRIORITY_NORMAL,
  type LexicalNode,
  type RangeSelection,
} from 'lexical';
import { $isListItemNode, type ListItemNode } from '@lexical/list';
import {
  $getClipboardDataFromSelection,
  setLexicalClipboardDataTransfer,
} from '@lexical/clipboard';

/** Nearest checklist-item ancestor of a content node, skipping inline wrappers (e.g. links). */
function $findChecklistItemAncestor(node: LexicalNode): ListItemNode | null {
  let current = node.getParent();
  while (current !== null) {
    if ($isElementNode(current) && !current.isInline()) {
      return $isListItemNode(current) && current.getChecked() !== undefined
        ? current
        : null;
    }
    current = current.getParent();
  }
  return null;
}

/**
 * Checklist items store their checked state as node data, not as visible
 * text, so Lexical's default plain-text clipboard serialization
 * (selection.getTextContent()) drops all trace of a checkbox once pasted
 * into a plain-text target (Slack, Notepad, ...). This rebuilds text/plain
 * with the same "- [ ] "/"- [x] " markers CHECK_LIST exports to markdown -
 * mirroring RangeSelection.getTextContent()'s own block-join logic - while
 * leaving text/html and application/x-lexical-editor untouched, so pasting
 * back into another Lexical editor still restores a real checkbox.
 *
 * The marker is emitted at the first content-bearing descendant of each
 * checklist item (tracked via `emittedChecklistKeys`) rather than at the
 * item's own element boundary: selection.getNodes() does not guarantee a
 * list item precedes its own text in document order (e.g. a Cmd+A select
 * starting inside the first item's text can yield [text, listitem, ...]),
 * so anchoring on the element would sometimes attach the marker to the
 * wrong line.
 */
function $getChecklistAwareTextContent(selection: RangeSelection): string {
  const nodes = selection.getNodes();
  if (nodes.length === 0) return '';

  const firstNode = nodes[0];
  const lastNode = nodes[nodes.length - 1];
  const { anchor, focus } = selection;
  const isBefore = anchor.isBefore(focus);
  const [anchorOffset, focusOffset] = $getCharacterOffsets(selection);

  let textContent = '';
  let prevWasElement = true;
  const emittedChecklistKeys = new Set<string>();
  for (const node of nodes) {
    if ($isElementNode(node) && !node.isInline()) {
      if (!prevWasElement) {
        textContent += '\n';
      }
      prevWasElement = !node.isEmpty();
    } else {
      prevWasElement = false;

      const checklistAncestor = $findChecklistItemAncestor(node);
      if (
        checklistAncestor &&
        !emittedChecklistKeys.has(checklistAncestor.getKey())
      ) {
        emittedChecklistKeys.add(checklistAncestor.getKey());
        textContent += `- [${checklistAncestor.getChecked() ? 'x' : ' '}] `;
      }

      if ($isTextNode(node)) {
        let text = node.getTextContent();
        if (node === firstNode) {
          if (node === lastNode) {
            if (
              anchor.type !== 'element' ||
              focus.type !== 'element' ||
              focus.offset === anchor.offset
            ) {
              text =
                anchorOffset < focusOffset
                  ? text.slice(anchorOffset, focusOffset)
                  : text.slice(focusOffset, anchorOffset);
            }
          } else {
            text = isBefore
              ? text.slice(anchorOffset)
              : text.slice(focusOffset);
          }
        } else if (node === lastNode) {
          text = isBefore
            ? text.slice(0, focusOffset)
            : text.slice(0, anchorOffset);
        }
        textContent += text;
      } else if (
        ($isDecoratorNode(node) || $isLineBreakNode(node)) &&
        (node !== lastNode || !selection.isCollapsed())
      ) {
        textContent += node.getTextContent();
      }
    }
  }
  return textContent;
}

/**
 * Writes checklist-aware clipboard data for the current selection, mirroring
 * @lexical/clipboard's own $copyToClipboardEvent (preventDefault + populate
 * text/html, application/x-lexical-editor, and text/plain). Returns false
 * (leaving the event untouched) when the selection doesn't touch a checklist
 * item, so Lexical's default COPY_COMMAND/CUT_COMMAND handling takes over.
 */
function $writeChecklistAwareClipboardData(event: ClipboardEvent): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;

  // Only take over when the selection actually spans a checklist item -
  // everything else keeps Lexical's default clipboard handling untouched.
  const hasChecklistItem = selection
    .getNodes()
    .some((node) => $isListItemNode(node) && node.getChecked() !== undefined);
  if (!hasChecklistItem) return false;

  const clipboardData = event.clipboardData;
  if (!clipboardData) return false;

  const data = $getClipboardDataFromSelection(selection);
  data['text/plain'] = $getChecklistAwareTextContent(selection);

  event.preventDefault();
  setLexicalClipboardDataTransfer(clipboardData, data);
  return true;
}

function $handleChecklistCut(event: ClipboardEvent): boolean {
  const handled = $writeChecklistAwareClipboardData(event);
  if (!handled) return false;

  // Default CUT_COMMAND handling (onCutForRichText) also removes the
  // selected content after copying it - replicate that here, since taking
  // over the command (returning true) skips Lexical's own cut handler.
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.removeText();
  }
  return true;
}

export function ChecklistClipboardPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterCopy = editor.registerCommand(
      COPY_COMMAND,
      $writeChecklistAwareClipboardData,
      COMMAND_PRIORITY_NORMAL
    );
    const unregisterCut = editor.registerCommand(
      CUT_COMMAND,
      $handleChecklistCut,
      COMMAND_PRIORITY_NORMAL
    );

    return () => {
      unregisterCopy();
      unregisterCut();
    };
  }, [editor]);

  return null;
}
