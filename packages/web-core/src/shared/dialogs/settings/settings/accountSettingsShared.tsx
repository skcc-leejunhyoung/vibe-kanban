import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RelayHost } from 'shared/remote-types';
import type { AccountHostStatus } from 'shared/types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { getAuthRuntime } from '@/shared/lib/auth/runtime';
import { HostAccountError } from '@/shared/lib/hostAccountApi';
import { OAuthDialog } from '@/shared/dialogs/global/OAuthDialog';
import { resetLocalSelfHost } from '@/shared/lib/accountHostTransport';
import { cn } from '@/shared/lib/utils';

export const accountButton =
  'inline-flex min-h-9 items-center justify-center gap-half rounded-sm border border-border px-base py-half text-base text-normal hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50';
export const accountInput =
  'min-h-9 min-w-0 w-full rounded-sm border border-border bg-primary px-base py-half text-base text-high';

export function shortAccountId(id: string) {
  return `${id.slice(0, 8)}…`;
}

export function accountDeviceLabel(label: string | null): string | null {
  if (!label) return null;
  const browser = /Edg\//.test(label)
    ? 'Edge'
    : /Firefox|FxiOS/.test(label)
      ? 'Firefox'
      : /Chrome|CriOS/.test(label)
        ? 'Chrome'
        : /Safari/.test(label)
          ? 'Safari'
          : null;
  const os = /iPad/.test(label)
    ? 'iPad'
    : /iPhone/.test(label)
      ? 'iPhone'
      : /Android/.test(label)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(label)
          ? 'macOS'
          : /Windows/.test(label)
            ? 'Windows'
            : /Linux/.test(label)
              ? 'Linux'
              : null;
  return browser || os ? [browser, os].filter(Boolean).join(' · ') : label;
}

export function hostStatusKey(host: RelayHost) {
  if (host.auth_mode === 'migrating')
    return 'settings.remoteAccess.status.migrating';
  if (host.auth_mode !== 'account')
    return 'settings.remoteAccess.status.legacy';
  if (!host.remote_access_enabled) return 'settings.remoteAccess.status.paused';
  return host.status === 'online'
    ? 'settings.remoteAccess.status.online'
    : 'settings.remoteAccess.status.offline';
}

export function HostStatus({ host }: { host: RelayHost }) {
  const { t } = useTranslation('settings');
  const online =
    host.auth_mode === 'account' &&
    host.remote_access_enabled &&
    host.status === 'online';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-half text-sm',
        online ? 'text-success' : 'text-low'
      )}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          online ? 'bg-success' : 'bg-low'
        )}
        aria-hidden="true"
      />
      {t(hostStatusKey(host))}
    </span>
  );
}

export async function localHostRegistration(
  method: 'GET' | 'POST',
  replace = false
): Promise<AccountHostStatus> {
  const response = await fetch(
    `/api/relay-auth/account/registration${replace ? '?replace=true' : ''}`,
    { method }
  );
  const result = await response.json();
  if (!response.ok || !result.success)
    throw new HostAccountError(
      response.status,
      response.status === 403
        ? 'REAUTHENTICATION_REQUIRED'
        : 'REGISTRATION_FAILED',
      result.message ?? 'Host registration unavailable'
    );
  if (method === 'POST') resetLocalSelfHost();
  return result.data;
}

export async function signInToAccount(reauthenticate = false) {
  const redirect = getAuthRuntime().redirectToOAuth;
  if (redirect) await redirect(undefined, reauthenticate);
  else await OAuthDialog.show({ reauthenticate });
}

const useAccountMutationLifecycle =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useAccountSettingsAction() {
  const { userId } = useAuth();
  const client = useQueryClient();
  const identity = useRef(userId);
  identity.current = userId;
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [status, setStatus] = useState('');
  useAccountMutationLifecycle(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run<T>(
    action: () => Promise<T>,
    message: string,
    onSuccess?: (value: T) => void | Promise<void>
  ): Promise<boolean> {
    if (inFlight.current || !mounted.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setStatus('');
    const actor = identity.current;
    const current = () => mounted.current && identity.current === actor;
    try {
      const value = await action();
      if (!current()) return false;
      await onSuccess?.(value);
      if (!current()) return false;
      setStatus(message);
      await client.invalidateQueries({
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
      return true;
    } catch (failure) {
      if (current())
        setError(
          failure instanceof Error ? failure : new Error(String(failure))
        );
      if (failure instanceof HostAccountError && failure.status === 409) {
        await client.invalidateQueries({
          predicate: (query) =>
            ['account-hosts', 'host-policy'].includes(
              String(query.queryKey[0])
            ),
        });
      }
      return false;
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  }
  return { busy, error, status, run };
}

export type AccountSettingsAction = ReturnType<typeof useAccountSettingsAction>;

export function AccountActionFeedback({
  action,
  onReauthenticate,
}: {
  action: AccountSettingsAction;
  onReauthenticate?: () => void;
}) {
  const { t } = useTranslation('settings');
  const code =
    action.error instanceof HostAccountError ? action.error.code : '';
  const message = [
    'HOST_GENERATION_CONFLICT',
    'GRANT_VERSION_CONFLICT',
  ].includes(code)
    ? t('settings.remoteAccess.errors.changed')
    : code === 'ACCOUNT_NOT_FOUND'
      ? t('settings.remoteAccess.errors.accountMissing')
      : code === 'ACCOUNT_SESSION_REVOKED'
        ? t('settings.remoteAccess.errors.session')
        : code === 'HOST_NOT_FOUND'
          ? t('settings.remoteAccess.errors.access')
          : action.error?.message;
  return (
    <>
      {action.error && (
        <div
          role="alert"
          className="space-y-base rounded-sm border border-error/30 bg-error/5 p-base text-base text-error"
        >
          <p className="break-words">{message}</p>
          {code === 'REAUTHENTICATION_REQUIRED' && (
            <>
              <p>{t('settings.remoteAccess.reauthenticateHint')}</p>
              <button
                type="button"
                className={accountButton}
                onClick={onReauthenticate ?? (() => void signInToAccount(true))}
              >
                {t('settings.remoteAccess.reauthenticate')}
              </button>
            </>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" className="text-sm text-low">
        {action.busy ? t('settings.remoteAccess.saving') : action.status}
      </p>
    </>
  );
}

export function AccountSettingsSignIn() {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-base rounded-sm border border-border bg-secondary/30 p-double">
      <h3 className="text-lg font-medium text-high">
        {t('settings.remoteAccess.signInTitle')}
      </h3>
      <p className="text-base text-low">
        {t('settings.remoteAccess.signInDescription')}
      </p>
      <button
        type="button"
        className={cn(
          accountButton,
          'border-brand bg-brand text-on-brand hover:bg-brand-hover'
        )}
        onClick={() => void signInToAccount()}
      >
        {t('settings.remoteAccess.signIn')}
      </button>
    </div>
  );
}

export function AccountSettingsTabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
  children,
}: {
  label: string;
  value: T;
  tabs: { id: T; label: string }[];
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        className="flex min-w-0 gap-base border-b border-border sm:gap-double"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${id}-${tab.id}`}
            aria-selected={value === tab.id}
            aria-controls={`${id}-panel`}
            tabIndex={value === tab.id ? 0 : -1}
            className={cn(
              'min-h-10 border-b-2 px-half pb-base text-base',
              value === tab.id
                ? 'border-brand font-medium text-high'
                : 'border-transparent text-low hover:text-normal'
            )}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              let next: number;
              switch (event.key) {
                case 'ArrowRight':
                  next = (index + 1) % tabs.length;
                  break;
                case 'ArrowLeft':
                  next = (index + tabs.length - 1) % tabs.length;
                  break;
                case 'Home':
                  next = 0;
                  break;
                case 'End':
                  next = tabs.length - 1;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              onChange(tabs[next].id);
              document.getElementById(`${id}-${tabs[next].id}`)?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${value}`}
        className="min-w-0 space-y-double"
      >
        {children}
      </div>
    </>
  );
}
