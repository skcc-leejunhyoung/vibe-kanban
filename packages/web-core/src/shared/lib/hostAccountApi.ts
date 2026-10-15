import type {
  AccountHostRegistration,
  AccountSessionInfo,
  ChangeHostStateRequest,
  HostAccessAuditEntry,
  HostAccountProfile,
  HostConnectionApproval,
  HostConnectionInfo,
  HostAccessPolicy,
  HostAccessGrant,
  ChangeHostAccessRequest,
  OpenHostConnectionRequest,
} from 'shared/remote-types';
import { makeRequest } from '@/shared/lib/remoteApi';

export class HostAccountError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export async function accountRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await makeRequest(
    path,
    init,
    ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new HostAccountError(
      response.status,
      error.code ?? 'CONTROL_PLANE_UNAVAILABLE',
      error.error ?? '연결을 복구하고 있습니다. 잠시 후 다시 시도해 주세요.'
    );
  }
  return response.json();
}
async function mutation<T>(
  path: string,
  method: string,
  body?: unknown
): Promise<T> {
  const result = await accountRequest<{ data: T }>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return result.data;
}
export const hostAccountApi = {
  policy: (host: string) =>
    accountRequest<HostAccessPolicy>(`/v1/hosts/${host}/access`),
  profile: (host: string, user: string) =>
    accountRequest<HostAccountProfile>(
      `/v1/hosts/${host}/accounts/${encodeURIComponent(user)}`
    ),
  grant: (host: string, user: string, request: ChangeHostAccessRequest) =>
    mutation<HostAccessGrant>(
      `/v1/hosts/${host}/access/${user}`,
      'PUT',
      request
    ),
  revoke: (host: string, user: string, request: ChangeHostAccessRequest) =>
    mutation<HostAccessGrant>(
      `/v1/hosts/${host}/access/${user}?${new URLSearchParams({ expected_host_generation: String(request.expected_host_generation), expected_version: String(request.expected_version) })}`,
      'DELETE'
    ),
  open: (host: string, request: OpenHostConnectionRequest) =>
    mutation<HostConnectionApproval>(
      `/v1/hosts/${host}/connections`,
      'POST',
      request
    ),
  connections: (host: string) =>
    accountRequest<HostConnectionInfo[]>(`/v1/hosts/${host}/connections`),
  terminate: (host: string, id: string) =>
    mutation<void>(`/v1/hosts/${host}/connections/${id}`, 'DELETE'),
  changeState: (host: string, request: ChangeHostStateRequest) =>
    mutation<void>(`/v1/hosts/${host}/state`, 'PATCH', request),
  unregister: (host: string, generation: number) =>
    mutation<void>(
      `/v1/hosts/${host}/state?expected_generation=${generation}&remote_access_enabled=false`,
      'DELETE'
    ),
  audit: (host: string) =>
    accountRequest<HostAccessAuditEntry[]>(`/v1/hosts/${host}/audit`),
  sessions: () => accountRequest<AccountSessionInfo[]>('/v1/account/sessions'),
  logoutSession: (id: string) =>
    mutation<void>(`/v1/account/sessions/${id}`, 'DELETE'),
  logoutAll: () => mutation<void>('/v1/account/sessions', 'DELETE'),
};
export type { AccountHostRegistration };
