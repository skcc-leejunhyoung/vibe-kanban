import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleIcon,
  DesktopIcon,
  PlusIcon,
  ShieldCheckIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import type {
  HostAccessPolicy,
  HostAccountProfile,
  RelayHost,
} from 'shared/remote-types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/Dialog';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import { Switch } from '@vibe/ui/components/Switch';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { hostAccountApi } from '@/shared/lib/hostAccountApi';
import { updateRelayHost } from '@/shared/lib/remoteApi';
import { getAuthRuntime } from '@/shared/lib/auth/runtime';
import { saveRemoteAccessDraft } from './remoteAccessDraft';
import { cn } from '@/shared/lib/utils';
import {
  AccountActionFeedback,
  AccountSettingsTabs,
  HostStatus,
  accountButton,
  accountInput,
  shortAccountId,
  useAccountSettingsAction,
  signInToAccount,
} from './accountSettingsShared';

type DetailTab = 'access' | 'connections' | 'activity' | 'settings';

function AccountLabel({
  hostId,
  accountId,
}: {
  hostId: string;
  accountId: string;
}) {
  const { userId } = useAuth();
  const { t } = useTranslation('settings');
  const profile = useQuery({
    queryKey: ['host-account-profile', userId, hostId, accountId],
    queryFn: () => hostAccountApi.profile(hostId, accountId),
    enabled: accountId !== userId,
    staleTime: 60_000,
    retry: false,
  });
  const name =
    profile.data?.username ||
    [profile.data?.first_name, profile.data?.last_name]
      .filter(Boolean)
      .join(' ');
  return (
    <details>
      <summary className="min-h-7 cursor-pointer break-words font-medium text-high">
        {accountId === userId
          ? t('settings.remoteAccess.you')
          : name || shortAccountId(accountId)}
      </summary>
      <code className="block break-all select-all py-half text-sm text-low">
        {accountId}
      </code>
    </details>
  );
}

export function AccountHostDetailsDialog({
  host,
  onClose,
  initialAccountId,
}: {
  host: RelayHost;
  onClose: () => void;
  initialAccountId?: string;
}) {
  const { t } = useTranslation('settings');
  const { userId } = useAuth();
  const owner = host.access_role === 'owner';
  const [tab, setTab] = useState<DetailTab>(owner ? 'access' : 'connections');
  const activeTab = owner ? tab : 'connections';
  const [shareOpen, setShareOpen] = useState(Boolean(initialAccountId));
  const [name, setName] = useState(host.name);
  const action = useAccountSettingsAction();
  const policy = useQuery({
    queryKey: ['host-policy', userId, host.id],
    queryFn: () => hostAccountApi.policy(host.id),
    enabled: owner,
    refetchInterval: activeTab === 'access' ? 10_000 : false,
  });
  const connections = useQuery({
    queryKey: ['host-connections', userId, host.id],
    queryFn: () => hostAccountApi.connections(host.id),
    enabled: activeTab === 'connections',
    refetchInterval: activeTab === 'connections' ? 5000 : false,
  });
  const audit = useQuery({
    queryKey: ['host-audit', userId, host.id],
    queryFn: () => hostAccountApi.audit(host.id),
    enabled: owner && activeTab === 'activity',
    refetchInterval: activeTab === 'activity' ? 10_000 : false,
  });
  const tabs: { id: DetailTab; label: string }[] = owner
    ? [
        { id: 'access', label: t('settings.remoteAccess.accessTab') },
        { id: 'connections', label: t('settings.remoteAccess.connectionsTab') },
        { id: 'activity', label: t('settings.remoteAccess.activityTab') },
        { id: 'settings', label: t('settings.remoteAccess.settingsTab') },
      ]
    : [{ id: 'connections', label: t('settings.remoteAccess.myConnections') }];
  async function revoke(user: string) {
    const grant = policy.data?.grants.find((g) => g.user_id === user);
    if (!owner || !grant || !policy.data) return;
    if (
      (await ConfirmDialog.show({
        title: t('settings.remoteAccess.revokeTitle'),
        message: t('settings.remoteAccess.revokeDescription', {
          host: host.name,
          account: shortAccountId(user),
        }),
        confirmText: t('settings.remoteAccess.revoke'),
        variant: 'destructive',
      })) !== 'confirmed'
    )
      return;
    await action.run(
      () =>
        hostAccountApi.revoke(host.id, user, {
          expected_host_generation: policy.data!.auth_generation,
          expected_version: grant.version,
        }),
      t('settings.remoteAccess.revoked')
    );
  }
  async function terminate(id: string) {
    if (
      (await ConfirmDialog.show({
        title: t('settings.remoteAccess.terminateTitle'),
        message: t('settings.remoteAccess.terminateDescription'),
        confirmText: t('settings.remoteAccess.terminate'),
        variant: 'default',
      })) !== 'confirmed'
    )
      return;
    await action.run(
      () => hostAccountApi.terminate(host.id, id),
      t('settings.remoteAccess.terminated')
    );
  }
  async function toggle() {
    if (!owner || host.auth_mode !== 'account') return;
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
  async function unregister() {
    if (
      !owner ||
      (await ConfirmDialog.show({
        title: t('settings.remoteAccess.unregisterTitle'),
        message: t('settings.remoteAccess.unregisterDescription', {
          host: host.name,
        }),
        confirmText: t('settings.remoteAccess.unregister'),
        variant: 'destructive',
      })) !== 'confirmed'
    )
      return;
    await action.run(
      () => hostAccountApi.unregister(host.id, host.auth_generation),
      t('settings.remoteAccess.unregistered'),
      onClose
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85dvh] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border p-double">
          <div className="flex min-w-0 items-center gap-base">
            <DesktopIcon className="size-9 shrink-0 text-low" />
            <div className="min-w-0 space-y-half">
              <DialogTitle className="break-words pr-double">
                {host.name}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-base">
                <HostStatus host={host} />
                <span>
                  {t(
                    owner
                      ? 'settings.remoteAccess.owner'
                      : 'settings.remoteAccess.shared'
                  )}
                </span>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 space-y-double overflow-y-auto p-base sm:p-double">
          <AccountSettingsTabs
            label={t('settings.remoteAccess.detailsLabel')}
            value={activeTab}
            onChange={setTab}
            tabs={tabs}
          >
            {activeTab === 'access' && owner && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-base">
                  <div>
                    <h3 className="font-medium text-high">
                      {t('settings.remoteAccess.accessAccounts')}
                    </h3>
                    <p className="mt-half text-sm text-low">
                      {t('settings.remoteAccess.accessAccountsHint')}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={accountButton}
                    disabled={
                      action.busy ||
                      !policy.data ||
                      host.auth_mode !== 'account'
                    }
                    onClick={() => setShareOpen(true)}
                  >
                    <PlusIcon className="size-icon-sm" />
                    {t('settings.remoteAccess.addUser')}
                  </button>
                </div>
                {host.auth_mode !== 'account' && (
                  <p className="rounded-sm bg-secondary p-base text-low">
                    {t('settings.remoteAccess.status.legacy')}
                  </p>
                )}
                {policy.isPending && (
                  <p role="status" className="text-low">
                    {t('settings.remoteAccess.loading')}
                  </p>
                )}
                {policy.isError && (
                  <div role="alert" className="space-y-base text-error">
                    <p>{t('settings.remoteAccess.policyLoadError')}</p>
                    <button
                      type="button"
                      className={accountButton}
                      onClick={() => void policy.refetch()}
                    >
                      {t('settings.remoteAccess.retry')}
                    </button>
                  </div>
                )}
                <div className="divide-y divide-border rounded-sm border border-border">
                  <div className="flex items-center justify-between gap-base p-base">
                    <div>
                      <p className="font-medium text-high">
                        {t('settings.remoteAccess.you')}
                      </p>
                      <p className="mt-half text-sm text-low">
                        {t('settings.remoteAccess.owner')}
                      </p>
                    </div>
                    <span className="text-sm text-low">
                      {t('settings.remoteAccess.ownerCannotRemove')}
                    </span>
                  </div>
                  {policy.data?.grants
                    .filter(
                      (g) => !g.revoked_at && g.user_id !== host.owner_user_id
                    )
                    .map((grant) => (
                      <div
                        key={grant.user_id}
                        className="flex flex-wrap items-center justify-between gap-base p-base"
                      >
                        <div className="min-w-0 flex-1">
                          <AccountLabel
                            hostId={host.id}
                            accountId={grant.user_id}
                          />
                          <p className="text-sm text-low">
                            {t('settings.remoteAccess.fullAccess')}
                          </p>
                        </div>
                        <button
                          type="button"
                          className={accountButton}
                          disabled={action.busy}
                          onClick={() => void revoke(grant.user_id)}
                        >
                          {t('settings.remoteAccess.revoke')}
                        </button>
                      </div>
                    ))}
                </div>
                <p className="flex gap-half text-sm text-low">
                  <ShieldCheckIcon className="size-icon-sm shrink-0" />
                  {t('settings.remoteAccess.linkDoesNotGrant')}
                </p>
              </>
            )}
            {activeTab === 'connections' && (
              <>
                <p className="text-sm text-low">
                  {t('settings.remoteAccess.terminateDescription')}
                </p>
                {!owner && (
                  <p className="rounded-sm bg-secondary p-base text-sm text-low">
                    {t('settings.remoteAccess.memberHint')}
                  </p>
                )}
                {connections.isPending && (
                  <p role="status" className="text-low">
                    {t('settings.remoteAccess.loading')}
                  </p>
                )}
                {connections.isError && (
                  <div role="alert" className="space-y-base text-error">
                    <p>{t('settings.remoteAccess.connectionsLoadError')}</p>
                    <button
                      type="button"
                      className={accountButton}
                      onClick={() => void connections.refetch()}
                    >
                      {t('settings.remoteAccess.retry')}
                    </button>
                  </div>
                )}
                {connections.data
                  ?.filter((c) => owner || c.user_id === userId)
                  .map((connection) => (
                    <div
                      key={connection.id}
                      className="flex flex-wrap items-center justify-between gap-base border-b border-border py-base"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-high">
                          {connection.user_id === userId
                            ? t('settings.remoteAccess.you')
                            : shortAccountId(connection.user_id)}
                        </p>
                        <p className="mt-half text-sm text-low">
                          {t('settings.remoteAccess.connectedAt', {
                            time: new Date(
                              connection.created_at
                            ).toLocaleString(),
                          })}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={accountButton}
                        disabled={action.busy}
                        onClick={() => void terminate(connection.id)}
                      >
                        {t('settings.remoteAccess.terminate')}
                      </button>
                    </div>
                  ))}
                {connections.data?.length === 0 && (
                  <p className="rounded-sm border border-border p-base text-low">
                    {t('settings.remoteAccess.noConnections')}
                  </p>
                )}
              </>
            )}
            {activeTab === 'activity' && owner && (
              <>
                <p className="text-sm text-low">
                  {t('settings.remoteAccess.auditRetention')}
                </p>
                {audit.isPending && (
                  <p role="status" className="text-low">
                    {t('settings.remoteAccess.loading')}
                  </p>
                )}
                {audit.isError && (
                  <div role="alert" className="space-y-base text-error">
                    <p>{t('settings.remoteAccess.auditLoadError')}</p>
                    <button
                      type="button"
                      className={accountButton}
                      onClick={() => void audit.refetch()}
                    >
                      {t('settings.remoteAccess.retry')}
                    </button>
                  </div>
                )}
                {audit.data?.length === 0 && (
                  <p className="text-low">
                    {t('settings.remoteAccess.noActivity')}
                  </p>
                )}
                {audit.data?.map((event) => (
                  <div
                    key={event.id}
                    className="space-y-half border-b border-border py-base"
                  >
                    <div className="flex flex-wrap items-center gap-base">
                      <p className="text-high">
                        {t(
                          `settings.remoteAccess.auditLabels.${event.action.replaceAll('.', '_')}`,
                          {
                            defaultValue: t(
                              'settings.remoteAccess.otherActivity'
                            ),
                          }
                        )}
                      </p>
                      <span
                        className={cn(
                          'text-sm',
                          event.result === 'allowed' ? 'text-low' : 'text-error'
                        )}
                      >
                        {t(
                          event.result === 'allowed'
                            ? 'settings.remoteAccess.allowed'
                            : 'settings.remoteAccess.denied'
                        )}
                      </span>
                    </div>
                    <p className="text-sm text-low">
                      {new Date(event.created_at).toLocaleString()} ·{' '}
                      {event.actor_id === userId
                        ? t('settings.remoteAccess.you')
                        : event.actor_id
                          ? shortAccountId(event.actor_id)
                          : t('settings.remoteAccess.system')}
                    </p>
                    {event.target_id &&
                      ['host.access_granted', 'host.access_revoked'].includes(
                        event.action
                      ) && (
                        <details className="text-sm text-low">
                          <summary className="cursor-pointer">
                            {t('settings.remoteAccess.auditTarget', {
                              account: shortAccountId(event.target_id),
                            })}
                          </summary>
                          <code className="block break-all select-all py-half">
                            {event.target_id}
                          </code>
                        </details>
                      )}
                  </div>
                ))}
              </>
            )}
            {activeTab === 'settings' && owner && (
              <>
                <form
                  className="space-y-base"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (name.trim())
                      void action.run(
                        () => updateRelayHost(host.id, { name: name.trim() }),
                        t('settings.remoteAccess.nameSaved')
                      );
                  }}
                >
                  <label className="block space-y-half">
                    <span className="font-medium text-normal">
                      {t('settings.remoteAccess.computerName')}
                    </span>
                    <input
                      className={accountInput}
                      maxLength={100}
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    className={accountButton}
                    disabled={
                      action.busy || !name.trim() || name.trim() === host.name
                    }
                  >
                    {t('settings.remoteAccess.saveName')}
                  </button>
                </form>
                <div className="flex items-center justify-between gap-double border-t border-border pt-base">
                  <div>
                    <h3 className="font-medium text-high">
                      {t('settings.remoteAccess.remoteOnThisComputer')}
                    </h3>
                    <p className="mt-half text-sm text-low">
                      {t('settings.remoteAccess.localWorkKept')}
                    </p>
                  </div>
                  <Switch
                    aria-label={t('settings.remoteAccess.remoteOnThisComputer')}
                    checked={host.remote_access_enabled}
                    onCheckedChange={() => void toggle()}
                    disabled={action.busy || host.auth_mode !== 'account'}
                  />
                </div>
                <details className="rounded-sm border border-border p-base">
                  <summary className="min-h-8 cursor-pointer text-low">
                    {t('settings.remoteAccess.unregister')}
                  </summary>
                  <div className="mt-base space-y-base">
                    <p className="text-base text-low">
                      {t('settings.remoteAccess.unregisterDescription', {
                        host: host.name,
                      })}
                    </p>
                    <button
                      type="button"
                      className={`${accountButton} text-error`}
                      disabled={action.busy}
                      onClick={() => void unregister()}
                    >
                      {t('settings.remoteAccess.unregister')}
                    </button>
                  </div>
                </details>
              </>
            )}
          </AccountSettingsTabs>
          <AccountActionFeedback action={action} />
        </div>
        {owner && shareOpen && policy.data && (
          <ShareHostDialog
            host={host}
            policy={policy.data}
            initialAccountId={initialAccountId}
            onClose={() => setShareOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShareHostDialog({
  host,
  policy,
  onClose,
  initialAccountId,
}: {
  host: RelayHost;
  policy: HostAccessPolicy;
  onClose: () => void;
  initialAccountId?: string;
}) {
  const { t } = useTranslation('settings');
  const { userId } = useAuth();
  const client = useQueryClient();
  const [user, setUser] = useState(initialAccountId ?? '');
  const currentUserInput = useRef(initialAccountId ?? '');
  const [profile, setProfile] = useState<HostAccountProfile | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const action = useAccountSettingsAction();
  const validId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      user.trim()
    );
  const existing =
    profile &&
    (profile.id === host.owner_user_id ||
      policy.grants.some((g) => g.user_id === profile.id && !g.revoked_at));
  async function lookup() {
    const id = user.trim().toLowerCase();
    if (!validId) return;
    await action.run(
      () => hostAccountApi.profile(host.id, id),
      '',
      (found) => {
        if (currentUserInput.current.trim().toLowerCase() !== id) return;
        setProfile(found);
        setConfirmed(false);
        client.setQueryData(
          ['host-account-profile', userId, host.id, found.id],
          found
        );
      }
    );
  }
  async function grant() {
    if (
      !profile ||
      !confirmed ||
      existing ||
      profile.id !== user.trim().toLowerCase() ||
      host.auth_mode !== 'account'
    )
      return;
    await action.run(
      () =>
        hostAccountApi.grant(host.id, profile.id, {
          expected_host_generation: policy.auth_generation,
          expected_version:
            policy.grants.find((g) => g.user_id === profile.id)?.version ?? 0,
        }),
      t('settings.remoteAccess.granted'),
      onClose
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.remoteAccess.addUser')}</DialogTitle>
          <DialogDescription>
            {t('settings.remoteAccess.addUserDescription', { host: host.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-double">
          <form
            className="space-y-base"
            onSubmit={(event) => {
              event.preventDefault();
              void lookup();
            }}
          >
            <label className="block space-y-half">
              <span className="text-base font-medium text-normal">
                {t('settings.remoteAccess.targetAccountId')}
              </span>
              <input
                className={accountInput}
                value={user}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setUser(event.target.value);
                  currentUserInput.current = event.target.value;
                  setProfile(null);
                  setConfirmed(false);
                }}
              />
            </label>
            <p className="text-sm text-low">
              {t('settings.remoteAccess.findAccountId')}
            </p>
            <button
              type="submit"
              className={accountButton}
              disabled={!validId || action.busy}
            >
              {action.busy && (
                <SpinnerIcon className="size-icon-sm animate-spin" />
              )}
              {t('settings.remoteAccess.checkAccount')}
            </button>
          </form>
          {profile && (
            <>
              <div className="space-y-base rounded-sm border border-border bg-secondary/30 p-base">
                <div className="flex items-center gap-half">
                  <CheckCircleIcon className="size-icon-sm text-success" />
                  <p className="text-base font-medium text-high">
                    {profile.username ||
                      [profile.first_name, profile.last_name]
                        .filter(Boolean)
                        .join(' ') ||
                      shortAccountId(profile.id)}
                  </p>
                </div>
                <code className="block break-all text-sm text-normal">
                  {profile.id}
                </code>
              </div>
              {existing ? (
                <p className="text-base text-low">
                  {t('settings.remoteAccess.alreadyAllowed')}
                </p>
              ) : (
                <label className="flex items-start gap-base text-base leading-relaxed text-normal">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0 accent-brand"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>
                    {t('settings.remoteAccess.confirmFullAccess', {
                      host: host.name,
                    })}
                  </span>
                </label>
              )}
            </>
          )}
          <AccountActionFeedback
            action={action}
            onReauthenticate={() => {
              setConfirmed(false);
              if (userId && getAuthRuntime().redirectToOAuth)
                saveRemoteAccessDraft(userId, host.id, user.trim());
              void action.run(() => signInToAccount(true), '');
            }}
          />
        </div>
        <DialogFooter>
          <button
            type="button"
            className={accountButton}
            disabled={action.busy}
            onClick={onClose}
          >
            {t('settings.remoteAccess.cancel')}
          </button>
          <button
            type="button"
            className={cn(
              accountButton,
              'border-brand bg-brand text-on-brand hover:bg-brand-hover'
            )}
            disabled={action.busy || !profile || !confirmed || !!existing}
            onClick={() => void grant()}
          >
            {t('settings.remoteAccess.grant')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
