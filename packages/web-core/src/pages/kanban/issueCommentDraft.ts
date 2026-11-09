import type { AppRuntime } from '@/shared/hooks/useAppRuntime';

export function getIssueCommentDraftId(
  issueId: string,
  runtime: AppRuntime
): string {
  // Local scratch IDs must be UUIDs; retain existing remote localStorage keys.
  return runtime === 'local' ? issueId : `issue-comment:${issueId}`;
}
