import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CopyIcon, DevicesIcon, UserCircleIcon } from '@phosphor-icons/react';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { hostAccountApi } from '@/shared/lib/hostAccountApi';
import { getAuthRuntime } from '@/shared/lib/auth/runtime';
import { resetAccountHostConnections } from '@/shared/lib/accountHostConnection';
import {
  AccountActionFeedback,
  AccountSettingsSignIn,
  accountButton,
  accountDeviceLabel,
  useAccountSettingsAction,
} from './AccountSettingsShared';

export function AccountSettingsSection() {
  const { isSignedIn, userId } = useAuth();
  // The key prevents a session request from the previous account updating this view.
  return isSignedIn && userId ? (
    <SignedInAccount key={userId} />
  ) : (
    <AccountSettingsSignIn />
  );
}

function SignedInAccount() {
  const { t } = useTranslation('settings');
  const { userId } = useAuth();
  const { loginStatus } = useUserSystem();
  const loginProfile =
    loginStatus?.status === 'loggedin' ? loginStatus.profile : null;
  const profile = loginProfile?.user_id === userId ? loginProfile : null;
  const action = useAccountSettingsAction();
  const sessions = useQuery({
    queryKey: ['account-sessions', userId],
    queryFn: hostAccountApi.sessions,
  });
  async function endSession(id?: string, current = false) {
    const result = await ConfirmDialog.show({
      title: t(
        id
          ? 'settings.remoteAccess.logoutDeviceTitle'
          : 'settings.remoteAccess.logoutAllTitle'
      ),
      message: t(
        id
          ? 'settings.remoteAccess.logoutDeviceDescription'
          : 'settings.remoteAccess.logoutAllDescription'
      ),
      confirmText: t('settings.remoteAccess.logout'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    await action.run(
      () =>
        id ? hostAccountApi.logoutSession(id) : hostAccountApi.logoutAll(),
      t('settings.remoteAccess.loggedOut'),
      async () => {
        if (!id || current) {
          resetAccountHostConnections();
          await getAuthRuntime().logout?.();
        }
      }
    );
  }
  return (
    <div className="space-y-double pb-double text-base">
      <p className="text-low">
        {t('settings.remoteAccess.accountDescription')}
      </p>
      <section className="space-y-base rounded-sm border border-border p-double">
        <div className="flex items-center gap-base">
          <UserCircleIcon className="size-9 text-low" />
          <div className="min-w-0">
            <h3 className="break-words text-lg font-medium text-high">
              {profile?.username ||
                profile?.email ||
                t('settings.remoteAccess.myAccount')}
            </h3>
            {profile?.username && profile.email && (
              <p className="break-all text-sm text-low">{profile.email}</p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-base border-t border-border pt-base">
          <div>
            <h4 className="font-medium text-high">
              {t('settings.remoteAccess.accountId')}
            </h4>
            <p className="mt-half text-sm text-low">
              {t('settings.remoteAccess.accountIdHint')}
            </p>
          </div>
          <button
            type="button"
            className={accountButton}
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () => navigator.clipboard.writeText(userId!),
                t('settings.remoteAccess.accountIdCopied')
              )
            }
          >
            <CopyIcon className="size-icon-sm" />
            {t('settings.remoteAccess.copyId')}
          </button>
        </div>
        <details>
          <summary className="min-h-8 cursor-pointer text-sm text-low">
            {t('settings.remoteAccess.showFullId')}
          </summary>
          <code className="block break-all select-all py-base text-sm text-normal">
            {userId}
          </code>
        </details>
      </section>
      <section
        className="space-y-base"
        aria-label={t('settings.remoteAccess.loginDevices')}
      >
        <div className="flex items-center gap-half">
          <DevicesIcon className="size-icon-sm text-low" />
          <h3 className="font-medium text-high">
            {t('settings.remoteAccess.loginDevices')}
          </h3>
        </div>
        <p className="text-sm text-low">
          {t('settings.remoteAccess.deviceNamesHint')}
        </p>
        {sessions.isPending && (
          <p role="status" className="text-low">
            {t('settings.remoteAccess.loading')}
          </p>
        )}
        {sessions.isError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-base rounded-sm border border-error/30 p-base"
          >
            <p>{t('settings.remoteAccess.devicesLoadError')}</p>
            <button
              type="button"
              className={accountButton}
              onClick={() => void sessions.refetch()}
            >
              {t('settings.remoteAccess.retry')}
            </button>
          </div>
        )}
        {sessions.data && (
          <div className="divide-y divide-border rounded-sm border border-border">
            {sessions.data.map((session) => (
              <div
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-base p-base"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-half">
                    <h4 className="min-w-0 break-words font-medium text-high">
                      {accountDeviceLabel(session.device_label) ??
                        t('settings.remoteAccess.unknownDevice')}
                    </h4>
                    {session.current && (
                      <span className="rounded-sm bg-secondary px-half text-sm text-low">
                        {t('settings.remoteAccess.currentDevice')}
                      </span>
                    )}
                  </div>
                  <p className="mt-half text-sm text-low">
                    {new Date(
                      session.last_used_at ?? session.created_at
                    ).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  className={accountButton}
                  disabled={action.busy}
                  onClick={() => void endSession(session.id, session.current)}
                >
                  {t('settings.remoteAccess.logout')}
                </button>
              </div>
            ))}
            {sessions.data.length === 0 && (
              <p className="p-base text-low">
                {t('settings.remoteAccess.noSessions')}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-base pt-base">
          <p className="text-sm text-low">
            {t('settings.remoteAccess.logoutKeepsHosts')}
          </p>
          <button
            type="button"
            className={`${accountButton} text-error`}
            disabled={action.busy}
            onClick={() => void endSession()}
          >
            {t('settings.remoteAccess.logoutAll')}
          </button>
        </div>
      </section>
      <AccountActionFeedback action={action} />
    </div>
  );
}
