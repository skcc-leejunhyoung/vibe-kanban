interface BoardNavigationStartState {
  isTextEditing: boolean;
}

export function shouldStartBoardNavigation({
  isTextEditing,
}: BoardNavigationStartState): boolean {
  // The board must reclaim arrow-key navigation even after focus moves to a
  // non-editable control elsewhere on the project page. Only text editing
  // keeps ownership of the arrow keys for caret movement.
  return !isTextEditing;
}
