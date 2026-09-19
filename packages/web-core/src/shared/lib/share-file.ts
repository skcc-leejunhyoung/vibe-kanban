/**
 * Hands a file to the native share sheet (Files, Mail, other apps). Resolves
 * false when the platform cannot share files so callers can fall back to a
 * download; a dismissed sheet counts as shared.
 */
export async function shareFile(blob: Blob, name: string): Promise<boolean> {
  const file = new File([blob], name, { type: blob.type });
  if (
    typeof navigator.share !== 'function' ||
    !navigator.canShare?.({ files: [file] })
  )
    return false;
  try {
    await navigator.share({ files: [file] });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError'))
      throw error;
  }
  return true;
}
