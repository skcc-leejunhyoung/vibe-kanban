import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
} from 'lexical';

const HANGUL_JAMO_REGEX = /[\u1100-\u11ff\u3130-\u318f]/;
const HANGUL_BASE_CODE = 0xac00;
const HANGUL_LAST_CODE = 0xd7a3;
const HANGUL_JUNG_COUNT = 21;
const HANGUL_JONG_COUNT = 28;

const COMPAT_CHO_SEONG = [
  'ㄱ',
  'ㄲ',
  'ㄴ',
  'ㄷ',
  'ㄸ',
  'ㄹ',
  'ㅁ',
  'ㅂ',
  'ㅃ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅉ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
];

const PREVIOUS_COMPOUND_JUNG: Record<number, number> = {
  9: 8,
  10: 8,
  11: 8,
  14: 13,
  15: 13,
  16: 13,
  19: 18,
};

const PREVIOUS_COMPOUND_JONG: Record<number, number> = {
  3: 1,
  5: 4,
  6: 4,
  9: 8,
  10: 8,
  11: 8,
  12: 8,
  13: 8,
  14: 8,
  15: 8,
  18: 17,
};

type SelectionTextBeforeCursor = {
  blockElement: HTMLElement;
  text: string;
};

type DomTextPointBeforeCursor = SelectionTextBeforeCursor & {
  offset: number;
  textNode: Text;
};

type ImeDebugWindow = Window & {
  __vibeImeDebugLog?: unknown[];
};

function isDeleteBeforeInput(event: InputEvent): boolean {
  return (
    event.inputType === 'deleteContentBackward' ||
    event.inputType === 'deleteCompositionText' ||
    event.inputType === 'deleteWordBackward' ||
    event.inputType === 'deleteSoftLineBackward' ||
    event.inputType === 'deleteHardLineBackward'
  );
}

function isCompositionInput(event: InputEvent): boolean {
  return (
    event.inputType === 'insertCompositionText' ||
    event.inputType === 'deleteCompositionText'
  );
}

function isDeleteKeyDown(event: KeyboardEvent): boolean {
  return (
    event.key === 'Backspace' &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

function getSelectionBlockElement(
  rootElement: HTMLElement,
  anchorNode: Node
): HTMLElement {
  let node =
    anchorNode.nodeType === Node.ELEMENT_NODE
      ? anchorNode
      : anchorNode.parentElement;

  while (
    node instanceof HTMLElement &&
    node.parentElement &&
    node.parentElement !== rootElement
  ) {
    node = node.parentElement;
  }

  return node instanceof HTMLElement && rootElement.contains(node)
    ? node
    : rootElement;
}

function getSelectionTextBeforeCursor(
  rootElement: HTMLElement
): SelectionTextBeforeCursor | null {
  const selection = rootElement.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  if (!anchorNode || !rootElement.contains(anchorNode)) {
    return null;
  }

  try {
    const blockElement = getSelectionBlockElement(rootElement, anchorNode);
    const range = rootElement.ownerDocument.createRange();
    range.setStart(blockElement, 0);
    range.setEnd(anchorNode, selection.anchorOffset);
    return { blockElement, text: range.toString() };
  } catch {
    return null;
  }
}

function getDomTextPointBeforeCursor(
  rootElement: HTMLElement
): DomTextPointBeforeCursor | null {
  const selectionText = getSelectionTextBeforeCursor(rootElement);
  if (!selectionText || selectionText.text.length === 0) {
    return null;
  }

  const { blockElement, text } = selectionText;
  const targetLength = text.length;
  const document = rootElement.ownerDocument;
  const walker = document.createTreeWalker(
    blockElement,
    NodeFilter.SHOW_TEXT
  );

  let previousLength = 0;
  let currentNode = walker.nextNode();

  while (currentNode) {
    const textNode = currentNode as Text;
    const range = document.createRange();

    try {
      range.setStart(blockElement, 0);
      range.setEnd(textNode, textNode.data.length);
    } catch {
      currentNode = walker.nextNode();
      continue;
    }

    const lengthThroughNode = range.toString().length;
    if (lengthThroughNode >= targetLength) {
      const offset = Math.min(
        textNode.data.length,
        Math.max(0, targetLength - previousLength)
      );

      return offset > 0
        ? { blockElement, offset, text, textNode }
        : null;
    }

    previousLength = lengthThroughNode;
    currentNode = walker.nextNode();
  }

  return null;
}

function stopLexicalEvent(event: Event): void {
  (event as Event & { _lexicalHandled?: boolean })._lexicalHandled = true;
  event.stopImmediatePropagation();
}

function logImeDebug(
  rootElement: HTMLElement,
  label: string,
  details: Record<string, unknown> = {}
): void {
  try {
    if (window.localStorage.getItem('vibeImeDebug') !== '1') {
      return;
    }

    const selectionText = getSelectionTextBeforeCursor(rootElement);
    const selection = rootElement.ownerDocument.getSelection();
    const entry = {
      label,
      selectionAnchorNode: selection?.anchorNode?.nodeName ?? null,
      selectionAnchorOffset: selection?.anchorOffset ?? null,
      selectionText: selectionText?.text ?? null,
      time: Math.round(performance.now()),
      ...details,
    };
    const debugWindow = window as ImeDebugWindow;
    debugWindow.__vibeImeDebugLog ??= [];
    debugWindow.__vibeImeDebugLog.push(entry);
    console.debug('[vibe-ime]', entry);
  } catch {
    // Debug logging must never affect editor input handling.
  }
}

function composeHangulSyllable(
  choIndex: number,
  jungIndex: number,
  jongIndex: number
): string {
  return String.fromCharCode(
    HANGUL_BASE_CODE +
      (choIndex * HANGUL_JUNG_COUNT + jungIndex) * HANGUL_JONG_COUNT +
      jongIndex
  );
}

function getPreviousHangulDeleteStep(text: string): string | null {
  const lastChar = text.at(-1);
  if (!lastChar) {
    return null;
  }

  if (HANGUL_JAMO_REGEX.test(lastChar)) {
    return '';
  }

  const code = lastChar.charCodeAt(0);
  if (code < HANGUL_BASE_CODE || code > HANGUL_LAST_CODE) {
    return null;
  }

  const syllableIndex = code - HANGUL_BASE_CODE;
  const choIndex = Math.floor(
    syllableIndex / (HANGUL_JUNG_COUNT * HANGUL_JONG_COUNT)
  );
  const jungIndex = Math.floor(
    (syllableIndex % (HANGUL_JUNG_COUNT * HANGUL_JONG_COUNT)) /
      HANGUL_JONG_COUNT
  );
  const jongIndex = syllableIndex % HANGUL_JONG_COUNT;

  if (jongIndex > 0) {
    return composeHangulSyllable(
      choIndex,
      jungIndex,
      PREVIOUS_COMPOUND_JONG[jongIndex] ?? 0
    );
  }

  const previousJungIndex = PREVIOUS_COMPOUND_JUNG[jungIndex];
  if (previousJungIndex !== undefined) {
    return composeHangulSyllable(choIndex, previousJungIndex, 0);
  }

  return COMPAT_CHO_SEONG[choIndex] ?? null;
}

export function ImeDeleteGuardPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let removeRootListeners: (() => void) | undefined;

    return editor.registerRootListener((rootElement) => {
      removeRootListeners?.();
      removeRootListeners = undefined;

      if (!rootElement) {
        return;
      }

      let isNativeComposing = false;
      let deleteKeySequence = 0;
      let activeDeleteKeySequence: number | null = null;
      let handledDeleteKeySequence: number | null = null;

      const clearDeleteKeySequence = () => {
        activeDeleteKeySequence = null;
        handledDeleteKeySequence = null;
      };

      const startDeleteKeySequence = () => {
        deleteKeySequence += 1;
        activeDeleteKeySequence = deleteKeySequence;
        handledDeleteKeySequence = null;

        return activeDeleteKeySequence;
      };

      const markDeleteKeySequenceHandled = () => {
        if (activeDeleteKeySequence !== null) {
          handledDeleteKeySequence = activeDeleteKeySequence;
        }
      };

      const isDuplicateDeleteBeforeInput = () => {
        return (
          activeDeleteKeySequence !== null &&
          handledDeleteKeySequence === activeDeleteKeySequence
        );
      };

      const hasHangulDeleteStepBeforeCursor = () => {
        return (
          getPreviousHangulDeleteStep(
            getSelectionTextBeforeCursor(rootElement)?.text ?? ''
          ) !== null
        );
      };

      const replaceSelectedText = (replacement: string) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }

        if (replacement.length === 0) {
          selection.removeText();
        } else {
          selection.insertText(replacement);
        }

        return true;
      };

      const applyHangulBackspace = () => {
        const domTextPoint = getDomTextPointBeforeCursor(rootElement);
        if (!domTextPoint) {
          logImeDebug(rootElement, 'apply:false-missing-dom-point');
          return false;
        }

        const replacement = getPreviousHangulDeleteStep(domTextPoint.text);
        if (replacement === null) {
          logImeDebug(rootElement, 'apply:false-no-replacement', {
            text: domTextPoint.text,
          });
          return false;
        }

        let didUpdate = false;
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return;
          }

          const anchor = selection.anchor;
          if (anchor.type !== 'text' || anchor.offset < 1) {
            return;
          }

          const anchorNode = anchor.getNode();
          if (!$isTextNode(anchorNode)) {
            return;
          }

          const anchorReplacement = getPreviousHangulDeleteStep(
            anchorNode.getTextContent().charAt(anchor.offset - 1)
          );
          if (anchorReplacement === null) {
            return;
          }

          selection.setTextNodeRange(
            anchorNode,
            anchor.offset - 1,
            anchorNode,
            anchor.offset
          );
          didUpdate = replaceSelectedText(anchorReplacement);
          logImeDebug(rootElement, 'apply:lexical-selection', {
            replacement: anchorReplacement,
          });
        });

        if (didUpdate) {
          return true;
        }

        editor.update(() => {
          const lexicalNode = $getNearestNodeFromDOMNode(
            domTextPoint.textNode
          );
          if (!$isTextNode(lexicalNode)) {
            logImeDebug(rootElement, 'apply:false-dom-node-not-text');
            return;
          }

          const text = lexicalNode.getTextContent();
          const fallbackReplacement = getPreviousHangulDeleteStep(
            text.charAt(domTextPoint.offset - 1)
          );
          if (
            domTextPoint.offset < 1 ||
            domTextPoint.offset > text.length ||
            fallbackReplacement === null
          ) {
            logImeDebug(rootElement, 'apply:false-dom-offset', {
              offset: domTextPoint.offset,
              text,
            });
            return;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            logImeDebug(rootElement, 'apply:false-no-range-selection');
            return;
          }

          selection.setTextNodeRange(
            lexicalNode,
            domTextPoint.offset - 1,
            lexicalNode,
            domTextPoint.offset
          );
          didUpdate = replaceSelectedText(fallbackReplacement);
          logImeDebug(rootElement, 'apply:dom-selection-fallback', {
            replacement: fallbackReplacement,
          });
        });

        return didUpdate;
      };

      const shouldLetBrowserHandleComposingDelete = (
        event: KeyboardEvent | InputEvent
      ): boolean => {
        return (
          isNativeComposing ||
          editor.isComposing() ||
          ('isComposing' in event && event.isComposing)
        );
      };

      const handleCompositionStart = () => {
        logImeDebug(rootElement, 'compositionstart');
        isNativeComposing = true;
      };

      const handleCompositionUpdate = (event: CompositionEvent) => {
        logImeDebug(rootElement, 'compositionupdate', { data: event.data });
      };

      const handleCompositionEnd = (event: CompositionEvent) => {
        logImeDebug(rootElement, 'compositionend', { data: event.data });
        isNativeComposing = false;
      };

      const handleKeyDownCapture = (event: KeyboardEvent) => {
        logImeDebug(rootElement, 'keydown', {
          editorIsComposing: editor.isComposing(),
          isComposing: event.isComposing,
          isNativeComposing,
          key: event.key,
        });

        if (!isDeleteKeyDown(event)) {
          clearDeleteKeySequence();
          return;
        }

        const deleteKeyId = startDeleteKeySequence();
        logImeDebug(rootElement, 'keydown:delete-sequence', {
          deleteKeyId,
        });

        if (hasHangulDeleteStepBeforeCursor()) {
          logImeDebug(rootElement, 'keydown:stop-hangul', {
            deleteKeyId,
          });
          stopLexicalEvent(event);
          return;
        }

        if (shouldLetBrowserHandleComposingDelete(event)) {
          logImeDebug(rootElement, 'keydown:stop-composing', { deleteKeyId });
          stopLexicalEvent(event);
        }
      };

      const handleKeyUpCapture = (event: KeyboardEvent) => {
        if (event.key !== 'Backspace') {
          return;
        }

        logImeDebug(rootElement, 'keyup:delete-sequence-end', {
          deleteKeyId: activeDeleteKeySequence,
        });
        clearDeleteKeySequence();
      };

      const handleBeforeInputCapture = (event: InputEvent) => {
        logImeDebug(rootElement, 'beforeinput', {
          data: event.data,
          editorIsComposing: editor.isComposing(),
          inputType: event.inputType,
          isComposing: event.isComposing,
          isNativeComposing,
        });

        if (!isDeleteBeforeInput(event)) {
          return;
        }

        if (isDuplicateDeleteBeforeInput()) {
          logImeDebug(rootElement, 'beforeinput:stop-duplicate-delete', {
            deleteKeyId: activeDeleteKeySequence,
            inputType: event.inputType,
          });
          event.preventDefault();
          stopLexicalEvent(event);
          return;
        }

        if (applyHangulBackspace()) {
          markDeleteKeySequenceHandled();
          event.preventDefault();
          stopLexicalEvent(event);
          return;
        }

        if (shouldLetBrowserHandleComposingDelete(event)) {
          logImeDebug(rootElement, 'beforeinput:stop-composing');
          stopLexicalEvent(event);
        }
      };

      const handleInputCapture = (event: Event) => {
        if (!(event instanceof InputEvent)) {
          return;
        }

        logImeDebug(rootElement, 'input', {
          data: event.data,
          inputType: event.inputType,
          isComposing: event.isComposing,
          isNativeComposing,
        });

        if (
          isCompositionInput(event) &&
          (isNativeComposing || ('isComposing' in event && event.isComposing))
        ) {
          stopLexicalEvent(event);
        }
      };

      const handleBlurCapture = () => {
        isNativeComposing = false;
        clearDeleteKeySequence();
      };

      rootElement.addEventListener('compositionstart', handleCompositionStart);
      rootElement.addEventListener(
        'compositionupdate',
        handleCompositionUpdate
      );
      rootElement.addEventListener('compositionend', handleCompositionEnd);
      rootElement.addEventListener('blur', handleBlurCapture, {
        capture: true,
      });
      rootElement.addEventListener('keydown', handleKeyDownCapture, {
        capture: true,
      });
      rootElement.addEventListener('keyup', handleKeyUpCapture, {
        capture: true,
      });
      rootElement.addEventListener('beforeinput', handleBeforeInputCapture, {
        capture: true,
      });
      rootElement.addEventListener('input', handleInputCapture, {
        capture: true,
      });

      removeRootListeners = () => {
        clearDeleteKeySequence();
        rootElement.removeEventListener(
          'compositionstart',
          handleCompositionStart
        );
        rootElement.removeEventListener(
          'compositionupdate',
          handleCompositionUpdate
        );
        rootElement.removeEventListener('compositionend', handleCompositionEnd);
        rootElement.removeEventListener('blur', handleBlurCapture, {
          capture: true,
        });
        rootElement.removeEventListener('keydown', handleKeyDownCapture, {
          capture: true,
        });
        rootElement.removeEventListener('keyup', handleKeyUpCapture, {
          capture: true,
        });
        rootElement.removeEventListener(
          'beforeinput',
          handleBeforeInputCapture,
          { capture: true }
        );
        rootElement.removeEventListener('input', handleInputCapture, {
          capture: true,
        });
      };
    });
  }, [editor]);

  return null;
}
