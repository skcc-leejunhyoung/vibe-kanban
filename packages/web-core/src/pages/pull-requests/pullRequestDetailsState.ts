export function shouldPreservePullRequestDetails(
  initialPrUrl: string | undefined,
  skipNextRepositoryReset: boolean
) {
  return Boolean(initialPrUrl) || skipNextRepositoryReset;
}
