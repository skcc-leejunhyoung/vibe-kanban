import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { HostAccountProfile, RelayHost } from 'shared/remote-types';
import type { AccountHostStatus } from 'shared/types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { getAuthRuntime } from '@/shared/lib/auth/runtime';
import {
  listRelayHosts,
  updateRelayHost,
  getRemoteApiUrl,
} from '@/shared/lib/remoteApi';
import { hostAccountApi, HostAccountError } from '@/shared/lib/hostAccountApi';
import { resetAccountHostConnections } from '@/shared/lib/accountHostConnection';
import { OAuthDialog } from '@/shared/dialogs/global/OAuthDialog';
import { resetLocalSelfHost } from '@/shared/lib/accountHostTransport';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';

const button =
  'rounded-sm border border-border px-base py-half text-normal hover:bg-secondary disabled:opacity-50';
const input =
  'min-w-0 w-full rounded-sm border border-border bg-primary px-base py-half text-normal';

async function localRegistration(
  method: 'GET' | 'POST',
  replace = false
): Promise<AccountHostStatus> {
  const response = await fetch(
    `/api/relay-auth/account/registration${replace ? '?replace=true' : ''}`,
    {
      method,
    }
  );
  const result = await response.json();
  if (!response.ok || !result.success)
    throw new HostAccountError(
      response.status,
      response.status === 403
        ? 'REAUTHENTICATION_REQUIRED'
        : 'REGISTRATION_FAILED',
      result.message ?? '호스트 등록 상태를 확인할 수 없습니다.'
    );
  if (method === 'POST') resetLocalSelfHost();
  return result.data;
}

export function AccountHostSettings({
  legacy,
  initialHostId,
}: {
  legacy: ReactNode;
  initialHostId?: string;
}) {
  const runtime = useAppRuntime();
  const { isSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(initialHostId ?? '');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [showSessions, setShowSessions] = useState(true);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const hosts = useQuery({
    queryKey: ['account-hosts', userId],
    queryFn: listRelayHosts,
    enabled: isSignedIn,
    refetchInterval: 10_000,
  });
  const local = useQuery({
    queryKey: ['account-host-registration'],
    queryFn: () => localRegistration('GET'),
    enabled: runtime === 'local',
  });
  const sessions = useQuery({
    queryKey: ['account-sessions', userId],
    queryFn: hostAccountApi.sessions,
    enabled: isSignedIn && showSessions,
  });
  const host = hosts.data?.find((host) => host.id === selected);
  const run = async (
    action: () => Promise<unknown>,
    message = '변경했습니다.'
  ) => {
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      await action();
      setStatus(message);
      await queryClient.invalidateQueries({
        predicate: (query) =>
          [
            'account-hosts',
            'host-policy',
            'host-connections',
            'host-audit',
            'account-sessions',
            'account-host-registration',
            'relay',
            'remote-cloud-hosts',
          ].includes(String(query.queryKey[0])),
      });
    } catch (error) {
      setError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(false);
    }
  };
  const login = () => {
    const redirect = getAuthRuntime().redirectToOAuth;
    return redirect
      ? redirect(undefined, true)
      : OAuthDialog.show({ reauthenticate: true });
  };
  return (
    <div className="flex min-w-0 flex-col gap-double text-base">
      <section
        className="flex flex-col gap-base rounded-sm border border-border p-base"
        aria-label="계정 원격 접속"
      >
        <h2 className="text-lg font-medium text-high">
          계정으로 원격 호스트 사용
        </h2>
        <p className="text-low">
          호스트를 한 번 등록하면 다른 기기에서도 같은 계정으로 로그인해 사용할
          수 있습니다.
        </p>
        {!isSignedIn ? (
          <PrimaryButton onClick={() => void login()}>로그인</PrimaryButton>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-half">
              <button
                className={button}
                onClick={() =>
                  void run(
                    () => navigator.clipboard.writeText(userId!),
                    '내 계정 ID를 복사했습니다.'
                  )
                }
              >
                내 계정 ID 복사
              </button>
              <button
                className={button}
                onClick={() => setShowSessions(!showSessions)}
                aria-expanded={showSessions}
              >
                로그인한 기기
              </button>
            </div>
            <span className="break-all text-low">{userId}</span>
          </>
        )}
        {showSessions && (
          <div className="flex flex-col gap-base">
            {sessions.isError && (
              <p role="alert">
                로그인 목록을 불러오지 못했습니다.{' '}
                <button
                  className={button}
                  onClick={() => void sessions.refetch()}
                >
                  다시 시도
                </button>
              </p>
            )}
            {sessions.data?.map((session) => (
              <div
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-half"
              >
                <span className="min-w-0 break-all">
                  {session.current ? '현재 로그인' : '다른 기기 로그인'} ·{' '}
                  {session.device_label ?? '기기 정보 없음'} ·{' '}
                  {new Date(
                    session.last_used_at ?? session.created_at
                  ).toLocaleString()}
                </span>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await hostAccountApi.logoutSession(session.id);
                      if (session.current) {
                        resetAccountHostConnections();
                        await getAuthRuntime().logout?.();
                        await queryClient.invalidateQueries();
                      }
                    }, '로그인 세션을 종료했습니다.')
                  }
                >
                  로그아웃
                </button>
              </div>
            ))}
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await hostAccountApi.logoutAll();
                  resetAccountHostConnections();
                  await getAuthRuntime().logout?.();
                  await queryClient.invalidateQueries();
                }, '모든 기기의 로그인 세션을 종료했습니다.')
              }
            >
              내 모든 기기 로그아웃
            </button>
          </div>
        )}
      </section>
      {runtime === 'local' && (
        <section
          className="flex flex-col gap-base rounded-sm border border-border p-base"
          aria-label="이 호스트 등록"
        >
          <h3 className="text-high">이 호스트 등록 상태</h3>
          <p className="break-all text-low">
            중앙 서버:{' '}
            {(local.data?.api_base ?? getRemoteApiUrl()) || '설정되지 않음'}
          </p>
          {local.isError && (
            <p role="alert">
              등록 상태를 불러오지 못했습니다.{' '}
              <button className={button} onClick={() => void local.refetch()}>
                다시 시도
              </button>
            </p>
          )}
          {local.data?.registration ? (
            <>
              <p>
                소유자:{' '}
                <span className="break-all">
                  {local.data.registration.owner_user_id}
                </span>
              </p>
              <p>
                {hosts.isSuccess &&
                !hosts.data.some(
                  (host) => host.id === local.data?.registration?.host_id
                )
                  ? '중앙 등록을 찾을 수 없습니다. 소유자 계정과 호스트 인증 복구를 확인하세요.'
                  : local.data.registration.auth_mode === 'account'
                    ? '등록됨 · 중앙 연결 상태는 아래 목록에서 확인하세요.'
                    : '등록 전환 중 · 다시 시도하면 같은 등록을 이어서 완료합니다.'}
              </p>
              <button
                className={button}
                onClick={() => setSelected(local.data!.registration!.host_id)}
              >
                이 호스트 관리
              </button>
            </>
          ) : (
            <p>현재 로그인한 계정이 이 호스트의 소유자가 됩니다.</p>
          )}
          {local.data?.registration?.auth_mode !== 'account' && (
            <button
              className={button}
              disabled={busy || !isSignedIn || local.isError}
              onClick={() =>
                void run(async () => {
                  const result = await localRegistration('POST');
                  if (result.registration)
                    setSelected(result.registration.host_id);
                }, '등록했습니다. 호스트의 실제 연결 상태를 확인하고 있습니다.')
              }
            >
              {local.data?.account_mode ? '등록 이어서 완료' : '이 호스트 등록'}
            </button>
          )}
          {local.data?.registration?.auth_mode === 'account' &&
            local.data.registration.owner_user_id === userId && (
              <details>
                <summary>호스트 인증 복구</summary>
                <label className="flex items-start gap-half">
                  <input
                    type="checkbox"
                    checked={confirmRecovery}
                    onChange={(e) => setConfirmRecovery(e.target.checked)}
                  />
                  기존 원격 연결을 종료하고 이 설치의 인증을 다시 발급합니다.
                  최근 5분 이내 로그인 확인이 필요합니다.
                </label>
                <button
                  className={button}
                  disabled={busy || !confirmRecovery}
                  onClick={() =>
                    void run(async () => {
                      await localRegistration('POST', true);
                      setConfirmRecovery(false);
                    }, '호스트 인증을 복구했습니다. 연결 상태를 확인하세요.')
                  }
                >
                  호스트 인증 재발급
                </button>
              </details>
            )}
          <p className="text-low">
            로컬에서 로그아웃해도 등록된 원격 접속은 계속 유지됩니다. 중지하려면
            호스트 관리에서 원격 접속을 끄세요.
          </p>
        </section>
      )}
      {isSignedIn && (
        <section
          className="flex flex-col gap-base rounded-sm border border-border p-base"
          aria-label="사용 가능한 호스트"
        >
          <h3 className="text-high">사용 가능한 호스트</h3>
          {hosts.isPending && (
            <p role="status">호스트 목록을 불러오고 있습니다.</p>
          )}
          {hosts.isError && (
            <p role="alert">
              호스트 목록을 불러오지 못했습니다.{' '}
              <button className={button} onClick={() => void hosts.refetch()}>
                다시 시도
              </button>
            </p>
          )}
          {hosts.isSuccess && hosts.data.length === 0 && (
            <p>
              사용할 수 있는 호스트가 없습니다. 이 컴퓨터를 등록하거나
              소유자에게 내 계정 ID를 전달하세요.
            </p>
          )}
          {hosts.data?.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-base border-b border-border py-half"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-high">
                  {row.name} ·{' '}
                  {row.access_role === 'owner' ? '소유자' : '사용자'}
                </p>
                <p className="text-low">
                  {row.auth_mode === 'migrating'
                    ? '호스트 연결을 확인하고 있습니다'
                    : row.auth_mode !== 'account'
                      ? '호스트 업데이트·계정 등록이 필요합니다'
                      : !row.remote_access_enabled
                        ? '원격 접속 중지됨'
                        : row.status === 'online'
                          ? '접속 가능'
                          : '호스트가 오프라인입니다'}
                  {row.last_seen_at &&
                    ` · ${new Date(row.last_seen_at).toLocaleString()}`}
                </p>
              </div>
              {row.auth_mode === 'account' && row.remote_access_enabled && (
                <a
                  className={button}
                  href={`/hosts/${encodeURIComponent(row.id)}/workspaces`}
                >
                  열기
                </a>
              )}
              <button
                className={button}
                onClick={() => setSelected(row.id)}
                aria-pressed={selected === row.id}
              >
                {row.access_role === 'owner' ? '관리' : '내 연결'}
              </button>
            </div>
          ))}
        </section>
      )}
      {host && (
        <HostDetails
          key={`${userId}:${host.id}`}
          host={host}
          busy={busy}
          run={run}
        />
      )}
      {error && (
        <div role="alert" className="text-error break-words">
          {error.message}
          {error instanceof HostAccountError &&
            error.code === 'REAUTHENTICATION_REQUIRED' && (
              <button className={button} onClick={() => void login()}>
                다시 로그인
              </button>
            )}
        </div>
      )}
      <p role="status" aria-live="polite">
        {busy ? '처리 중입니다…' : status}
      </p>
      {!local.data?.account_mode && (
        <details>
          <summary className="cursor-pointer text-low">
            기존 페어링 방식 설정
          </summary>
          {legacy}
        </details>
      )}
    </div>
  );
}

function HostDetails({
  host,
  busy,
  run,
}: {
  host: RelayHost;
  busy: boolean;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const { userId } = useAuth();
  const owner = host.access_role === 'owner';
  const [user, setUser] = useState('');
  const [profile, setProfile] = useState<HostAccountProfile | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [name, setName] = useState(host.name);
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const policy = useQuery({
    queryKey: ['host-policy', userId, host.id],
    queryFn: () => hostAccountApi.policy(host.id),
    enabled: owner,
  });
  const connections = useQuery({
    queryKey: ['host-connections', userId, host.id],
    queryFn: () => hostAccountApi.connections(host.id),
    refetchInterval: 5000,
  });
  const audit = useQuery({
    queryKey: ['host-audit', userId, host.id],
    queryFn: () => hostAccountApi.audit(host.id),
    enabled: owner,
    refetchInterval: 10_000,
  });
  return (
    <section
      className="flex min-w-0 flex-col gap-base rounded-sm border border-border p-base"
      aria-label={`${host.name} 관리`}
    >
      <h3 className="text-lg text-high">{host.name}</h3>
      <p className="break-all text-low">소유자: {host.owner_user_id}</p>
      {owner && (
        <>
          <label className="flex flex-col gap-half">
            호스트 이름
            <input
              className={input}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button
            className={button}
            disabled={busy || !name.trim()}
            onClick={() => void run(() => updateRelayHost(host.id, { name }))}
          >
            이름 저장
          </button>
          <button
            className={button}
            disabled={busy || host.auth_mode !== 'account'}
            onClick={() =>
              void run(
                () =>
                  hostAccountApi.changeState(host.id, {
                    expected_generation: host.auth_generation,
                    remote_access_enabled: !host.remote_access_enabled,
                  }),
                host.remote_access_enabled
                  ? '원격 접속을 중지했습니다. 로컬 작업은 유지됩니다.'
                  : '원격 접속을 켰습니다.'
              )
            }
          >
            {host.remote_access_enabled ? '원격 접속 중지' : '원격 접속 켜기'}
          </button>
          <h4 className="text-high">접근 계정</h4>
          <p className="break-all">
            {host.owner_user_id} · 소유자 · 제거할 수 없음
          </p>
          {policy.isError && (
            <p role="alert">
              접근 계정을 불러오지 못했습니다.{' '}
              <button className={button} onClick={() => void policy.refetch()}>
                다시 시도
              </button>
            </p>
          )}
          {policy.data?.grants
            .filter((grant) => !grant.revoked_at)
            .map((grant) => (
              <div
                key={grant.user_id}
                className="flex flex-wrap items-center gap-half"
              >
                <span className="break-all">
                  {grant.user_id} ·{' '}
                  {new Date(grant.created_at).toLocaleDateString()}
                </span>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        hostAccountApi.revoke(host.id, grant.user_id, {
                          expected_host_generation:
                            policy.data!.auth_generation,
                          expected_version: grant.version,
                        }),
                      '접근을 해제했습니다. 열린 연결이 종료됩니다.'
                    )
                  }
                >
                  접근 해제
                </button>
              </div>
            ))}
          <label className="flex flex-col gap-half">
            추가할 계정 ID
            <input
              className={input}
              value={user}
              autoComplete="off"
              onChange={(e) => {
                setUser(e.target.value);
                setProfile(null);
                setConfirmed(false);
              }}
            />
          </label>
          <button
            className={button}
            disabled={busy || !/^[0-9a-f-]{36}$/i.test(user.trim())}
            onClick={() =>
              void run(
                async () =>
                  setProfile(
                    await hostAccountApi.profile(host.id, user.trim())
                  ),
                '계정 정보를 확인한 후 접근을 허용하세요.'
              )
            }
          >
            정확한 계정 확인
          </button>
          {profile && (
            <div className="flex flex-col gap-half">
              <p className="break-all">
                {profile.username ??
                  [profile.first_name, profile.last_name]
                    .filter(Boolean)
                    .join(' ')}{' '}
                · {profile.id}
              </p>
              <label className="flex items-start gap-half">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                이 계정은 이 호스트의 파일을 다루고 명령을 실행할 수 있습니다.
              </label>
              <button
                className={button}
                disabled={
                  busy ||
                  !confirmed ||
                  !policy.data ||
                  profile.id === host.owner_user_id
                }
                onClick={() =>
                  void run(
                    () =>
                      hostAccountApi.grant(host.id, profile.id, {
                        expected_host_generation: policy.data!.auth_generation,
                        expected_version:
                          policy.data!.grants.find(
                            (g) => g.user_id === profile.id
                          )?.version ?? 0,
                      }),
                    '이 계정에 호스트 접근을 허용했습니다.'
                  )
                }
              >
                접근 허용
              </button>
            </div>
          )}
        </>
      )}
      <h4 className="text-high">현재 연결</h4>
      <p className="text-low">
        연결 종료 후에도 접근 권한은 남아 있으므로 다시 접속할 수 있습니다.
      </p>
      {connections.isError && (
        <p role="alert">
          연결 목록을 불러오지 못했습니다.{' '}
          <button className={button} onClick={() => void connections.refetch()}>
            다시 시도
          </button>
        </p>
      )}
      {connections.data?.length === 0 && <p>열린 연결이 없습니다.</p>}
      {connections.data?.map((connection) => (
        <div
          key={connection.id}
          className="flex flex-wrap items-center gap-half"
        >
          <span className="break-all">
            {connection.user_id} ·{' '}
            {new Date(connection.created_at).toLocaleString()}
          </span>
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void run(
                () => hostAccountApi.terminate(host.id, connection.id),
                '연결을 종료했습니다.'
              )
            }
          >
            연결 종료
          </button>
        </div>
      ))}
      {owner && (
        <>
          <details>
            <summary>최근 접속 기록 · 30일 보관</summary>
            {audit.isError && (
              <p role="alert">접속 기록을 불러오지 못했습니다.</p>
            )}
            <ul className="flex flex-col gap-half">
              {audit.data?.map((event) => (
                <li key={event.id} className="break-all text-low">
                  {new Date(event.created_at).toLocaleString()} · {event.action}{' '}
                  · {event.actor_id}
                </li>
              ))}
            </ul>
          </details>
          <label className="flex items-start gap-half">
            <input
              type="checkbox"
              checked={confirmUnregister}
              onChange={(e) => setConfirmUnregister(e.target.checked)}
            />
            등록을 해제하면 모든 원격 연결과 접근 허용이 종료됩니다. 로컬 파일과
            실행 중인 작업은 삭제하지 않습니다.
          </label>
          <button
            className={button}
            disabled={busy || !confirmUnregister}
            onClick={() =>
              void run(
                () => hostAccountApi.unregister(host.id, host.auth_generation),
                '호스트 등록을 해제했습니다.'
              )
            }
          >
            호스트 등록 해제
          </button>
        </>
      )}
    </section>
  );
}
