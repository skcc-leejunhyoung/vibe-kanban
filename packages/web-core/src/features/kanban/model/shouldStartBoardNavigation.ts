interface BoardNavigationStartState {
  isActivePane: boolean;
  isBoardFocused: boolean;
  isDocumentUnfocused: boolean;
  isPaneFocused: boolean;
  isTextEditing: boolean;
}

export function shouldStartBoardNavigation({
  isActivePane,
  isBoardFocused,
  isDocumentUnfocused,
  isPaneFocused,
  isTextEditing,
}: BoardNavigationStartState): boolean {
  // Reclaim navigation when the browser loses its concrete focus target, but
  // never steal arrow keys from controls elsewhere on the project page.
  return (
    isActivePane &&
    !isTextEditing &&
    (isBoardFocused || isDocumentUnfocused || isPaneFocused)
  );
}
