export function isVSCodeWebviewPath(pathname: string): boolean {
  return pathname.endsWith('/vscode');
}

/** Returns true only for the dedicated VS Code webview route. */
export function isVSCodeWebview(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      window.self !== window.top &&
      isVSCodeWebviewPath(window.location.pathname)
    );
  } catch {
    return isVSCodeWebviewPath(window.location.pathname);
  }
}

/** Ask the VS Code extension host to open a file. */
export function openFileInVSCode(
  filePath: string,
  options?: { lineNumber?: number; openAsDiff?: boolean }
) {
  if (!isVSCodeWebview()) return;
  window.parent.postMessage(
    {
      type: 'VIBE_OPEN_FILE',
      filePath,
      lineNumber: options?.lineNumber,
      openAsDiff: options?.openAsDiff ?? true,
    },
    '*'
  );
}
