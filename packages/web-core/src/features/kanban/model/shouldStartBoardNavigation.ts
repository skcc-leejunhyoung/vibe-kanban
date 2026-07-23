interface BoardNavigationStartState {
  isBoardFocused: boolean;
  isDocumentUnfocused: boolean;
  isTextEditing: boolean;
}

export function shouldStartBoardNavigation({
  isBoardFocused,
  isDocumentUnfocused,
  isTextEditing,
}: BoardNavigationStartState): boolean {
  // Reclaim navigation when the browser loses its concrete focus target, but
  // never steal arrow keys from controls elsewhere on the project page.
  return !isTextEditing && (isBoardFocused || isDocumentUnfocused);
}
