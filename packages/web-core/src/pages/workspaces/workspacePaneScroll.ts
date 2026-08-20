export interface PaneScrollPosition {
  element: Pick<HTMLElement, 'scrollLeft' | 'scrollTop'>;
  scrollLeft: number;
  scrollTop: number;
}

export function capturePaneScrollPositions(
  root: ParentNode
): PaneScrollPosition[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-workspace-pane], [data-workspace-pane] *'
    )
  )
    .filter(
      (element) =>
        element.scrollHeight > element.clientHeight ||
        element.scrollWidth > element.clientWidth
    )
    .map((element) => ({
      element,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
    }));
}

export function restorePaneScrollPositions(
  positions: PaneScrollPosition[]
): void {
  for (const { element, scrollLeft, scrollTop } of positions) {
    element.scrollLeft = scrollLeft;
    element.scrollTop = scrollTop;
  }
}
