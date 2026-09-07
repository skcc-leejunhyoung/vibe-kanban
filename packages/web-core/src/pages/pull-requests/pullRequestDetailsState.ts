import {
  getPullRequestNumberFromUrl,
  normalizeGitHubPullRequestUrl,
} from './pullRequestUrl';

export function getPullRequestTargetFromUrl(prUrl: string | undefined) {
  const url = prUrl ? normalizeGitHubPullRequestUrl(prUrl) : null;
  const number = url ? getPullRequestNumberFromUrl(url) : null;
  return url && number !== null ? { url, number } : null;
}
