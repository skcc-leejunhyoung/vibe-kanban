import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  DesktopIcon,
  LaptopIcon,
  PlusIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import type { RelayHost } from 'shared/remote-types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useAppRuntime } from '@/shared/hooks/useAppRuntime';
import { listRelayHosts } from '@/shared/lib/remoteApi';
import { AccountHostDetailsDialog } from './AccountHostDetailsDialog';
import {
  LocalAccountHostSettings,
  RegisterComputerGuide,
} from './LocalAccountHostSettings';
import {
  AccountSettingsSignIn,
  AccountSettingsTabs,
  HostStatus,
  accountButton,
  localHostRegistration,
} from './AccountSettingsShared';

export function AccountHostSettings({
  legacy,
  initialHostId,
  initialAccountId,
  onOpenAccount,
}: {
  legacy: ReactNode;
  initialHostId?: string;
  initialAccountId?: string;
  onOpenAccount?: () => void;
}) {
  const { isSignedIn, userId } = useAuth();
  const runtime = useAppRuntime();
  return isSignedIn && userId ? (
    <SignedInHostSettings
      key={`${runtime}:${userId}`}
      legacy={legacy}
      initialHostId={initialHostId}
      initialAccountId={initialAccountId}
      onOpenAccount={onOpenAccount}
    />
  ) : (
    <AccountSettingsSignIn />
  );
}

function SignedInHostSettings({
  legacy,
  initialHostId,
  initialAccountId,
  onOpenAccount,
}: {
  legacy: ReactNode;
  initialHostId?: string;
  initialAccountId?: string;
  onOpenAccount?: () => void;
}) {
  const { t } = useTranslation('settings');
  const { userId } = useAuth();
  const runtime = useAppRuntime();
  const [tab, setTab] = useState<'computers' | 'this'>('computers');
  const [selected, setSelected] = useState(initialHostId ?? '');
  const [showGuide, setShowGuide] = useState(false);
  const [showRegistration, setShowRegistration] = useState(false);
  const hosts = useQuery({
    queryKey: ['account-hosts', userId],
    queryFn: listRelayHosts,
    refetchInterval: 10_000,
  });
  const local = useQuery({
    queryKey: ['account-host-registration', userId],
    queryFn: () => localHostRegistration('GET'),
    enabled: runtime === 'local',
    refetchInterval: tab === 'this' ? 10_000 : false,
  });
  const selfId =
    runtime === 'local' ? local.data?.registration?.host_id : undefined;
  const self = hosts.data?.find((host) => host.id === selfId);
  const host = hosts.data?.find((host) => host.id === selected);
  const owned =
    hosts.data?.filter((host) => host.access_role === 'owner') ?? [];
  const shared =
    hosts.data?.filter((host) => host.access_role !== 'owner') ?? [];
  const canRegisterThisComputer =
    local.isSuccess &&
    (!local.data.registration ||
      (local.data.registration.owner_user_id === userId &&
        (local.data.registration.auth_mode !== 'account' ||
          (hosts.isSuccess && !self))));
  const addComputer = () => {
    if (runtime === 'local' && canRegisterThisComputer) {
      setTab('this');
      setShowRegistration(true);
    } else setShowGuide(true);
  };
  function group(title: string, rows: RelayHost[]) {
    if (!rows.length) return null;
    return (
      <section className="space-y-base" aria-label={title}>
        <h3 className="flex items-center gap-half font-medium text-high">
          {title}
          <span className="rounded-sm bg-secondary px-half text-sm text-low">
            {rows.length}
          </span>
        </h3>
        <div className="divide-y divide-border overflow-hidden rounded-sm border border-border">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-start gap-base p-base sm:items-center sm:p-plusfifty"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-border bg-secondary text-low">
                {row.id === selfId ? (
                  <LaptopIcon className="size-icon-lg" />
                ) : (
                  <DesktopIcon className="size-icon-lg" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-base">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-half">
                    <button
                      type="button"
                      className="break-words text-left font-medium text-high hover:underline"
                      onClick={() => setSelected(row.id)}
                    >
                      {row.name}
                    </button>
                    {row.id === selfId && (
                      <span className="rounded-sm bg-secondary px-half text-sm text-low">
                        {t('settings.remoteAccess.thisComputer')}
                      </span>
                    )}
                  </div>
                  <div className="mt-half flex flex-wrap items-center gap-half">
                    <HostStatus host={row} />
                    {row.last_seen_at && row.status !== 'online' && (
                      <span className="text-sm text-low">
                        ·{' '}
                        {t('settings.remoteAccess.lastSeen', {
                          time: new Date(row.last_seen_at).toLocaleString(),
                        })}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className={accountButton}
                  aria-label={`${row.name}: ${t(row.access_role === 'owner' ? 'settings.remoteAccess.manage' : 'settings.remoteAccess.myConnections')}`}
                  onClick={() => setSelected(row.id)}
                >
                  {t(
                    row.access_role === 'owner'
                      ? 'settings.remoteAccess.manage'
                      : 'settings.remoteAccess.myConnections'
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
        {rows === shared && (
          <p className="flex items-start gap-half text-sm text-low">
            <UsersIcon className="mt-px size-icon-sm shrink-0" />
            {t('settings.remoteAccess.sharedHint')}
          </p>
        )}
      </section>
    );
  }
  return (
    <div className="space-y-double pb-double text-base">
      <div className="flex flex-wrap items-start justify-between gap-base">
        <p className="max-w-sm text-low">
          {t('settings.remoteAccess.description')}
        </p>
        <button type="button" className={accountButton} onClick={addComputer}>
          <PlusIcon className="size-icon-sm" />
          {t('settings.remoteAccess.addComputer')}
        </button>
      </div>
      <AccountSettingsTabs
        label={t('settings.remoteAccess.tabsLabel')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'computers', label: t('settings.remoteAccess.computers') },
          {
            id: 'this',
            label: t(
              runtime === 'local'
                ? 'settings.remoteAccess.thisComputerSettings'
                : 'settings.remoteAccess.registerGuide'
            ),
          },
        ]}
      >
        {tab === 'computers' ? (
          <>
            {hosts.isPending && (
              <p role="status" className="py-double text-low">
                {t('settings.remoteAccess.loading')}
              </p>
            )}
            {hosts.isError && (
              <div
                role="alert"
                className="space-y-base rounded-sm border border-error/30 bg-error/5 p-base"
              >
                <p>{t('settings.remoteAccess.hostsLoadError')}</p>
                {hosts.data && (
                  <p className="text-sm text-low">
                    {t('settings.remoteAccess.previousList')}
                  </p>
                )}
                <button
                  type="button"
                  className={accountButton}
                  onClick={() => void hosts.refetch()}
                >
                  {t('settings.remoteAccess.retry')}
                </button>
              </div>
            )}
            {hosts.isSuccess && hosts.data.length === 0 && (
              <section className="space-y-base rounded-sm border border-dashed border-border bg-secondary/20 p-double text-center">
                <DesktopIcon className="mx-auto size-10 text-low" />
                <h3 className="text-lg font-medium text-high">
                  {t('settings.remoteAccess.emptyTitle')}
                </h3>
                <p className="text-low">
                  {t(
                    runtime === 'local'
                      ? 'settings.remoteAccess.emptyLocal'
                      : 'settings.remoteAccess.emptyRemote'
                  )}
                </p>
                <button
                  type="button"
                  className={accountButton}
                  onClick={() => {
                    setTab('this');
                    if (runtime === 'local' && canRegisterThisComputer)
                      setShowRegistration(true);
                  }}
                >
                  {t(
                    runtime === 'local'
                      ? 'settings.remoteAccess.registerThis'
                      : 'settings.remoteAccess.registerGuide'
                  )}
                </button>
              </section>
            )}
            {group(t('settings.remoteAccess.myComputers'), owned)}
            {group(t('settings.remoteAccess.sharedComputers'), shared)}
            <div className="flex flex-wrap items-center justify-between gap-base border-t border-border pt-base">
              <div>
                <p className="text-normal">
                  {t('settings.remoteAccess.missingComputer')}
                </p>
                <p className="mt-half text-sm text-low">
                  {t('settings.remoteAccess.requestAccess')}
                </p>
              </div>
              {onOpenAccount && (
                <button
                  type="button"
                  className={accountButton}
                  onClick={onOpenAccount}
                >
                  {t('settings.remoteAccess.accountId')}
                </button>
              )}
            </div>
            {(runtime === 'local'
              ? local.isSuccess && !local.data.account_mode
              : hosts.data?.some(
                  (row) => row.auth_mode === 'legacy_pairing'
                )) && (
              <details className="rounded-sm border border-border p-base">
                <summary className="min-h-8 cursor-pointer text-low">
                  {t('settings.remoteAccess.legacySettings')}
                </summary>
                <div className="mt-base">{legacy}</div>
              </details>
            )}
          </>
        ) : runtime === 'local' ? (
          <LocalAccountHostSettings
            state={local}
            host={self}
            hostsReady={hosts.isSuccess}
            registrationOpen={showRegistration}
            onRegistrationOpenChange={setShowRegistration}
            onManage={setSelected}
          />
        ) : (
          <RegisterComputerGuide />
        )}
      </AccountSettingsTabs>
      {host && (
        <AccountHostDetailsDialog
          key={`${userId}:${host.id}`}
          host={host}
          initialAccountId={
            host.id === initialHostId ? initialAccountId : undefined
          }
          onClose={() => setSelected('')}
        />
      )}
      {selected && !host && hosts.isSuccess && (
        <p role="status" className="text-low">
          {t('settings.remoteAccess.hostUnavailable')}
        </p>
      )}
      {showGuide && (
        <RegisterComputerGuide dialog onClose={() => setShowGuide(false)} />
      )}
    </div>
  );
}
