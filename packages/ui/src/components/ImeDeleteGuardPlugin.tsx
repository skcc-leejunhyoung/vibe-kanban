import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

function isDeleteBeforeInput(event: InputEvent): boolean {
  return (
    event.inputType === 'deleteContentBackward' ||
    event.inputType === 'deleteWordBackward' ||
    event.inputType === 'deleteSoftLineBackward' ||
    event.inputType === 'deleteHardLineBackward'
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

      const shouldLetBrowserHandleDelete = (
        event: KeyboardEvent | InputEvent
      ): boolean => {
        return (
          isNativeComposing ||
          editor.isComposing() ||
          ('isComposing' in event && event.isComposing)
        );
      };

      const handleCompositionStart = () => {
        isNativeComposing = true;
      };

      const handleCompositionEnd = () => {
        isNativeComposing = false;
      };

      const handleKeyDownCapture = (event: KeyboardEvent) => {
        if (isDeleteKeyDown(event) && shouldLetBrowserHandleDelete(event)) {
          event.stopPropagation();
        }
      };

      const handleBeforeInputCapture = (event: InputEvent) => {
        if (isDeleteBeforeInput(event) && shouldLetBrowserHandleDelete(event)) {
          event.stopPropagation();
        }
      };

      rootElement.addEventListener('compositionstart', handleCompositionStart);
      rootElement.addEventListener('compositionend', handleCompositionEnd);
      rootElement.addEventListener('keydown', handleKeyDownCapture, {
        capture: true,
      });
      rootElement.addEventListener('beforeinput', handleBeforeInputCapture, {
        capture: true,
      });

      removeRootListeners = () => {
        rootElement.removeEventListener(
          'compositionstart',
          handleCompositionStart
        );
        rootElement.removeEventListener('compositionend', handleCompositionEnd);
        rootElement.removeEventListener('keydown', handleKeyDownCapture, {
          capture: true,
        });
        rootElement.removeEventListener(
          'beforeinput',
          handleBeforeInputCapture,
          { capture: true }
        );
      };
    });
  }, [editor]);

  return null;
}
