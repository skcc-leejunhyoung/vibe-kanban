import { useCallback, useEffect, useRef } from 'react';
import { useHotkeysContext } from 'react-hotkeys-hook';

const DIALOG_SCOPE = 'dialog';

interface HotkeyScopeControls {
  activeScopes: string[];
  enableScope: (scope: string) => void;
  disableScope: (scope: string) => void;
}

const openModalStack: symbol[] = [];
let scopesToRestore: string[] = [];

export function registerModalKeyboardLayer(
  id: symbol,
  controls: HotkeyScopeControls
) {
  if (openModalStack.length === 0) {
    scopesToRestore = [...controls.activeScopes];
    scopesToRestore.forEach(controls.disableScope);
    controls.enableScope(DIALOG_SCOPE);
  }

  openModalStack.push(id);

  return () => {
    const index = openModalStack.lastIndexOf(id);
    if (index === -1) return;
    openModalStack.splice(index, 1);

    if (openModalStack.length === 0) {
      controls.disableScope(DIALOG_SCOPE);
      scopesToRestore.forEach(controls.enableScope);
      scopesToRestore = [];
    }
  };
}

export function isModalKeyboardActive() {
  return openModalStack.length > 0;
}

export function isTopModalKeyboardLayer(id: symbol) {
  return openModalStack[openModalStack.length - 1] === id;
}

/**
 * Registers an open modal as the exclusive owner of application keyboard
 * shortcuts. Native listeners can use `isModalKeyboardActive`, while
 * react-hotkeys-hook listeners are isolated through the dialog scope.
 */
export function useModalKeyboardLayer(open: boolean) {
  const { activeScopes, enableScope, disableScope } = useHotkeysContext();
  const idRef = useRef<symbol>();
  const activeScopesRef = useRef(activeScopes);
  activeScopesRef.current = activeScopes;

  if (!idRef.current) {
    idRef.current = Symbol('modal-keyboard-layer');
  }

  useEffect(() => {
    if (!open) return;
    return registerModalKeyboardLayer(idRef.current!, {
      activeScopes: activeScopesRef.current,
      enableScope,
      disableScope,
    });
  }, [open, enableScope, disableScope]);

  const isTopLayer = useCallback(
    () => isTopModalKeyboardLayer(idRef.current!),
    []
  );

  return { isTopLayer };
}
