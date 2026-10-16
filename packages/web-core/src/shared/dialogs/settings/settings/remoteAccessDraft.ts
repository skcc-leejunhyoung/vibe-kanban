import { getRemoteApiUrl } from '@/shared/lib/remoteApi';

const KEY = 'vk-remote-access-reauth';
const MAX_AGE = 10 * 60 * 1000;
type Draft = {
  userId: string;
  server: string;
  hostId: string;
  accountId: string;
  savedAt: number;
};

// Only an unsubmitted account ID is restored; permission consent is never saved.
export function saveRemoteAccessDraft(
  userId: string,
  hostId: string,
  accountId: string
): void {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        userId,
        hostId,
        accountId,
        server: getRemoteApiUrl(),
        savedAt: Date.now(),
      } satisfies Draft)
    );
  } catch {
    /* The form can still be completed if browser storage is unavailable. */
  }
}

export function takeRemoteAccessDraft(
  userId: string
): { hostId: string; accountId: string } | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const draft: unknown = JSON.parse(raw);
    if (!draft || typeof draft !== 'object') return null;
    const value = draft as Partial<Draft>;
    if (
      value.userId !== userId ||
      value.server !== getRemoteApiUrl() ||
      typeof value.savedAt !== 'number' ||
      Date.now() - value.savedAt > MAX_AGE ||
      value.savedAt > Date.now() ||
      typeof value.hostId !== 'string' ||
      typeof value.accountId !== 'string'
    )
      return null;
    return { hostId: value.hostId, accountId: value.accountId };
  } catch {
    return null;
  }
}
