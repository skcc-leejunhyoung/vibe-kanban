import { useState } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LaptopIcon, SpinnerIcon, UsersIcon } from '@phosphor-icons/react';
import type { AccountHostStatus } from 'shared/types';
import type { RelayHost } from 'shared/remote-types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@vibe/ui/components/Dialog';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { Switch } from '@vibe/ui/components/Switch';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { getRemoteApiUrl, updateRelayHost } from '@/shared/lib/remoteApi';
import { hostAccountApi } from '@/shared/lib/hostAccountApi';
import { cn } from '@/shared/lib/utils';
import {
  AccountActionFeedback,
  HostStatus,
  accountButton,
  accountInput,
  localHostRegistration,
  useAccountSettingsAction,
} from './accountSettingsShared';

export function RegisterComputerGuide({
  dialog = false,
  onClose,
}: {
  dialog?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation('settings');
  const content = (
    <div className="space-y-double text-base">
      <p className="text-low">{t('settings.remoteAccess.registerOnHost')}</p>
      <ol className="list-decimal space-y-base pl-double text-normal">
        <li>{t('settings.remoteAccess.guideRun')}</li>
        <li>{t('settings.remoteAccess.guideSettings')}</li>
        <li>{t('settings.remoteAccess.guideRegister')}</li>
        <li>{t('settings.remoteAccess.guideReturn')}</li>
      </ol>
      <p className="rounded-sm border border-border bg-secondary/30 p-base text-low">
        {t('settings.remoteAccess.guideBrowserHint')}
      </p>
    </div>
  );
  if (!dialog)
    return (
      <section className="space-y-double">
        <h3 className="text-lg font-medium text-high">
          {t('settings.remoteAccess.registerGuide')}
        </h3>
        {content}
      </section>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.remoteAccess.registerGuide')}</DialogTitle>
          <DialogDescription>
            {t('settings.remoteAccess.guideDescription')}
          </DialogDescription>
        </DialogHeader>
        {content}
        <DialogFooter>
          <button type="button" className={accountButton} onClick={onClose}>
            {t('settings.remoteAccess.close')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LocalAccountHostSettings({
  state,
  host,
  hostsReady,
  registrationOpen,
  onRegistrationOpenChange,
  onManage,
}: {
  state: UseQueryResult<AccountHostStatus>;
  host?: RelayHost;
  hostsReady: boolean;
  registrationOpen: boolean;
  onRegistrationOpenChange: (open: boolean) => void;
  onManage: (id: string) => void;
}) {
  const { t } = useTranslation('settings');
  const { userId } = useAuth();
  const { config, loginStatus } = useUserSystem();
  const client = useQueryClient();
  const action = useAccountSettingsAction();
  const [name, setName] = useState(
    config?.host_nickname || t('settings.remoteAccess.defaultComputerName')
  );
  const registration = state.data?.registration;
  const owner = registration?.owner_user_id === userId;
  const profile =
    loginStatus?.status === 'loggedin' ? loginStatus.profile : null;
  const accountName =
    profile?.user_id === userId ? profile.username || profile.email : null;
  async function register() {
    if (!name.trim()) return;
    await action.run(
      () =>
        state.data?.registration?.auth_mode === 'account'
          ? Promise.resolve(state.data)
          : localHostRegistration('POST'),
      t('settings.remoteAccess.registeredWaiting'),
      async (registered) => {
        client.setQueryData(['account-host-registration', userId], registered);
        // Registration has already committed even if the separate name update fails.
        void client.invalidateQueries({ queryKey: ['account-hosts', userId] });
        if (registered?.registration) {
          try {
            await updateRelayHost(registered.registration.host_id, {
              name: name.trim(),
            });
          } catch {
            throw new Error(t('settings.remoteAccess.registeredNameFailed'));
          }
        }
        onRegistrationOpenChange(false);
      }
    );
  }
  async function toggle() {
    if (!host || host.access_role !== 'owner') return;
    if (
      host.remote_access_enabled &&
      (await ConfirmDialog.show({
        title: t('settings.remoteAccess.pauseTitle'),
        message: t('settings.remoteAccess.pauseDescription'),
        confirmText: t('settings.remoteAccess.pause'),
        variant: 'destructive',
      })) !== 'confirmed'
    )
      return;
    await action.run(
      () =>
        hostAccountApi.changeState(host.id, {
          expected_generation: host.auth_generation,
          remote_access_enabled: !host.remote_access_enabled,
        }),
      t(
        host.remote_access_enabled
          ? 'settings.remoteAccess.paused'
          : 'settings.remoteAccess.enabled'
      )
    );
  }
  async function repair() {
    if (
      !owner ||
      (await ConfirmDialog.show({
        title: t('settings.remoteAccess.repairTitle'),
        message: t('settings.remoteAccess.repairDescription'),
        confirmText: t('settings.remoteAccess.repair'),
        variant: 'destructive',
      })) !== 'confirmed'
    )
      return;
    await action.run(
      () => localHostRegistration('POST', true),
      t('settings.remoteAccess.repaired')
    );
  }
  return (
    <div className="space-y-double">
      {state.isPending && (
        <p role="status" className="text-low">
          {t('settings.remoteAccess.loading')}
        </p>
      )}
      {state.isError && (
        <div
          role="alert"
          className="space-y-base rounded-sm border border-error/30 p-base"
        >
          <p>{t('settings.remoteAccess.registrationLoadError')}</p>
          <button
            type="button"
            className={accountButton}
            onClick={() => void state.refetch()}
          >
            {t('settings.remoteAccess.retry')}
          </button>
        </div>
      )}
      {state.isSuccess &&
        (registration ? (
          <>
            <section className="space-y-double rounded-sm border border-border p-double">
              <div className="flex items-center gap-base">
                <LaptopIcon className="size-10 shrink-0 text-low" />
                <div className="min-w-0">
                  <p className="text-sm text-low">
                    {t('settings.remoteAccess.thisComputer')}
                  </p>
                  <h3 className="break-words text-lg font-medium text-high">
                    {host?.name ??
                      config?.host_nickname ??
                      t('settings.remoteAccess.defaultComputerName')}
                  </h3>
                  {host ? (
                    <HostStatus host={host} />
                  ) : (
                    <p className="text-sm text-low">
                      {t('settings.remoteAccess.registeredWaiting')}
                    </p>
                  )}
                </div>
              </div>
              {!owner && (
                <p className="rounded-sm bg-secondary p-base text-low">
                  {t('settings.remoteAccess.otherOwner')}
                </p>
              )}
              {owner && host?.auth_mode === 'account' && (
                <div className="flex items-center justify-between gap-double border-t border-border pt-base">
                  <div>
                    <h4 className="font-medium text-high">
                      {t('settings.remoteAccess.remoteOnThisComputer')}
                    </h4>
                    <p className="mt-half text-sm text-low">
                      {t('settings.remoteAccess.sameAccountHint')}
                    </p>
                  </div>
                  <Switch
                    aria-label={t('settings.remoteAccess.remoteOnThisComputer')}
                    checked={host.remote_access_enabled}
                    onCheckedChange={() => void toggle()}
                    disabled={action.busy}
                  />
                </div>
              )}
              {host && (
                <div className="flex flex-wrap items-center justify-between gap-base border-t border-border pt-base">
                  <div>
                    <h4 className="font-medium text-high">
                      {t('settings.remoteAccess.accessAccounts')}
                    </h4>
                    <p className="mt-half text-sm text-low">
                      {t('settings.remoteAccess.accessAccountsHint')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={accountButton}
                    onClick={() => onManage(host.id)}
                  >
                    <UsersIcon className="size-icon-sm" />
                    {t(
                      owner
                        ? 'settings.remoteAccess.manageAccess'
                        : 'settings.remoteAccess.myConnections'
                    )}
                  </button>
                </div>
              )}
              {registration.auth_mode !== 'account' && owner && (
                <div className="space-y-base">
                  <p className="text-low">
                    {t('settings.remoteAccess.migrationHint')}
                  </p>
                  <button
                    type="button"
                    className={accountButton}
                    disabled={action.busy}
                    onClick={() => onRegistrationOpenChange(true)}
                  >
                    {t('settings.remoteAccess.resumeRegistration')}
                  </button>
                </div>
              )}
              {hostsReady && !host && (
                <p role="status" className="text-low">
                  {t(
                    owner
                      ? 'settings.remoteAccess.registrationMissing'
                      : 'settings.remoteAccess.otherOwner'
                  )}
                </p>
              )}
            </section>
            <p className="text-sm text-low">
              {t('settings.remoteAccess.localWorkKept')}
            </p>
            <details className="rounded-sm border border-border p-base">
              <summary className="min-h-8 cursor-pointer text-low">
                {t('settings.remoteAccess.advanced')}
              </summary>
              <div className="mt-base space-y-double">
                <div>
                  <p className="text-sm text-low">
                    {t('settings.remoteAccess.centralServer')}
                  </p>
                  <p className="mt-half break-all text-normal">
                    {state.data.api_base ?? getRemoteApiUrl()}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-low">
                    {t('settings.remoteAccess.registeredAccount')}
                  </p>
                  <code className="mt-half block break-all text-sm text-normal">
                    {owner ? accountName || userId : registration.owner_user_id}
                  </code>
                </div>
                {owner && registration.auth_mode === 'account' && (
                  <div className="space-y-base border-t border-border pt-base">
                    <h4 className="font-medium text-high">
                      {t('settings.remoteAccess.repairTitle')}
                    </h4>
                    <p className="text-sm text-low">
                      {t('settings.remoteAccess.repairHint')}
                    </p>
                    <button
                      type="button"
                      className={accountButton}
                      disabled={action.busy}
                      onClick={() => void repair()}
                    >
                      {t('settings.remoteAccess.repair')}
                    </button>
                  </div>
                )}
              </div>
            </details>
          </>
        ) : (
          <section className="space-y-base rounded-sm border border-dashed border-border p-double text-center">
            <LaptopIcon className="mx-auto size-10 text-low" />
            <h3 className="text-lg font-medium text-high">
              {t('settings.remoteAccess.registerTitle')}
            </h3>
            <p className="text-low">
              {t('settings.remoteAccess.registerDescription')}
            </p>
            <button
              type="button"
              className={accountButton}
              onClick={() => onRegistrationOpenChange(true)}
            >
              {t('settings.remoteAccess.registerThis')}
            </button>
          </section>
        ))}
      {!registrationOpen && <AccountActionFeedback action={action} />}
      <Dialog
        open={registrationOpen}
        onOpenChange={(open) => {
          if (!action.busy) onRegistrationOpenChange(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.remoteAccess.registerThis')}</DialogTitle>
            <DialogDescription>
              {t('settings.remoteAccess.registerDescription')}
            </DialogDescription>
          </DialogHeader>
          <form
            id="register-account-host"
            className="space-y-double"
            onSubmit={(event) => {
              event.preventDefault();
              void register();
            }}
          >
            <label className="block space-y-half">
              <span className="text-base font-medium text-normal">
                {t('settings.remoteAccess.computerName')}
              </span>
              <input
                className={accountInput}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
                disabled={action.busy}
              />
            </label>
            <div className="space-y-half">
              <p className="text-sm text-low">
                {t('settings.remoteAccess.registeredAccount')}
              </p>
              <p className="break-all text-normal">{accountName || userId}</p>
            </div>
            <p className="rounded-sm bg-secondary p-base text-base text-low">
              {t('settings.remoteAccess.ownerOnlyInitially')}
            </p>
            <details>
              <summary className="min-h-8 cursor-pointer text-sm text-low">
                {t('settings.remoteAccess.centralServer')}
              </summary>
              <p className="break-all py-base text-sm text-normal">
                {state.data?.api_base ?? getRemoteApiUrl()}
              </p>
            </details>
            <AccountActionFeedback action={action} />
          </form>
          <DialogFooter>
            <button
              type="button"
              className={accountButton}
              disabled={action.busy}
              onClick={() => onRegistrationOpenChange(false)}
            >
              {t('settings.remoteAccess.cancel')}
            </button>
            <button
              type="submit"
              form="register-account-host"
              className={cn(
                accountButton,
                'border-brand bg-brand text-on-brand hover:bg-brand-hover'
              )}
              disabled={
                action.busy ||
                !state.isSuccess ||
                (!!registration && !owner) ||
                !name.trim()
              }
            >
              {action.busy && (
                <SpinnerIcon className="size-icon-sm animate-spin" />
              )}
              {t('settings.remoteAccess.registerThis')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
