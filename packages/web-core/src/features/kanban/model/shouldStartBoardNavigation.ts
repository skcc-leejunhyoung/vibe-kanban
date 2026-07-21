interface BoardNavigationStartState {
  isBoardFocused: boolean;
  hasCursor: boolean;
  hasOpenedIssue: boolean;
  activeElementTagName: string | null;
}

export function shouldStartBoardNavigation({
  isBoardFocused,
  hasCursor,
  hasOpenedIssue,
  activeElementTagName,
}: BoardNavigationStartState): boolean {
  if (isBoardFocused) return true;
  if (hasCursor || hasOpenedIssue) return false;

  return (
    activeElementTagName === null ||
    activeElementTagName === 'BODY' ||
    activeElementTagName === 'HTML'
  );
}
