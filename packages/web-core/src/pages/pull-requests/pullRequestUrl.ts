const GITHUB_REPOSITORY_COMPONENT = /^(?!\.{1,2}$)[a-z0-9._-]{1,100}$/i;

export function isGitHubRepositoryFullName(value: string): boolean {
  const segments = value.split('/');
  return (
    segments.length === 2 &&
    segments.every((segment) => GITHUB_REPOSITORY_COMPONENT.test(segment))
  );
}

function getGitHubPullRequestSegments(prUrl: string): string[] | null {
  const url = new URL(prUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password
  ) {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const number = Number(segments[3]);
  return segments.length === 4 &&
    segments[2] === 'pull' &&
    GITHUB_REPOSITORY_COMPONENT.test(segments[0]) &&
    GITHUB_REPOSITORY_COMPONENT.test(segments[1]) &&
    Number.isSafeInteger(number) &&
    number > 0 &&
    number <= 2_147_483_647
    ? segments
    : null;
}

export function normalizeGitHubPullRequestUrl(prUrl: string): string | null {
  try {
    const segments = getGitHubPullRequestSegments(prUrl);
    return segments
      ? `https://github.com/${segments[0]}/${segments[1]}/pull/${segments[3]}`
      : null;
  } catch {
    return null;
  }
}

export function getRepositoryFullNameFromPrUrl(prUrl: string): string | null {
  try {
    const segments = getGitHubPullRequestSegments(prUrl);
    return segments ? `${segments[0]}/${segments[1]}` : null;
  } catch {
    return null;
  }
}

export function getPullRequestNumberFromUrl(prUrl: string): number | null {
  try {
    const segments = getGitHubPullRequestSegments(prUrl);
    if (!segments) return null;
    return Number(segments[3]);
  } catch {
    return null;
  }
}
