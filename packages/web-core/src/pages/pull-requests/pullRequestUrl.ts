export function getRepositoryNameFromPrUrl(prUrl: string): string | null {
  try {
    const segments = new URL(prUrl).pathname.split('/').filter(Boolean);
    return segments.length >= 4 && segments[2] === 'pull' ? segments[1] : null;
  } catch {
    return null;
  }
}

export function getPullRequestNumberFromUrl(prUrl: string): number | null {
  try {
    const segments = new URL(prUrl).pathname.split('/').filter(Boolean);
    const pullIndex = segments.lastIndexOf('pull');
    if (pullIndex < 0 || pullIndex + 1 >= segments.length) return null;
    const number = Number(segments[pullIndex + 1]);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}
