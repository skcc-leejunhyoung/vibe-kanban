import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@phosphor-icons/react';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import {
  userNotificationPreferencesApi,
  type UserNotificationPreference,
} from '@/shared/lib/api';
import {
  SettingsCard,
  SettingsCheckbox,
  SettingsSaveBar,
} from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';

const QUERY_KEY = ['user-notification-preferences'] as const;

export function AccountNotificationsSettingsSection() {
  const { t } = useTranslation('settings');
  const { setDirty: setContextDirty } = useSettingsDirty();
  const queryClient = useQueryClient();
  const { isSignedIn, isLoaded } = useAuth();
  const enabled = isLoaded && isSignedIn;

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: userNotificationPreferencesApi.get,
    enabled,
  });

  const [draft, setDraft] = useState<UserNotificationPreference | null>(null);

  useEffect(() => {
    if (data) {
      setDraft(data);
    }
  }, [data]);

  const hasUnsavedChanges = useMemo(
    () =>
      Boolean(
        draft &&
          data &&
          draft.review_requested_enabled !== data.review_requested_enabled
      ),
    [data, draft]
  );

  useEffect(() => {
    setContextDirty('notifications', hasUnsavedChanges);
    return () => setContextDirty('notifications', false);
  }, [hasUnsavedChanges, setContextDirty]);

  const mutation = useMutation({
    mutationFn: userNotificationPreferencesApi.update,
    onSuccess: (preference) => {
      queryClient.setQueryData(QUERY_KEY, preference);
      setDraft(preference);
    },
  });

  const handleSave = useCallback(() => {
    if (!draft) return;
    mutation.mutate({
      review_requested_enabled: draft.review_requested_enabled,
    });
  }, [draft, mutation]);

  const handleDiscard = useCallback(() => {
    setDraft(data ?? null);
  }, [data]);

  if (!isLoaded || (enabled && isLoading)) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <SpinnerIcon
          className="size-icon-lg animate-spin text-brand"
          weight="bold"
        />
        <span className="text-normal">
          {t('settings.accountNotifications.loading', {
            defaultValue: 'Loading notification settings...',
          })}
        </span>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="py-8">
        <div className="bg-secondary border border-border rounded-sm p-4 text-low">
          {t('settings.accountNotifications.signInRequired', {
            defaultValue: 'Sign in to manage account notification settings.',
          })}
        </div>
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div className="py-8">
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {t('settings.accountNotifications.loadError', {
            defaultValue: 'Failed to load notification settings.',
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      {mutation.isError && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {t('settings.accountNotifications.saveError', {
            defaultValue: 'Failed to save notification settings.',
          })}
        </div>
      )}

      <SettingsCard
        title={t('settings.accountNotifications.review.title', {
          defaultValue: 'Review requests',
        })}
        description={t('settings.accountNotifications.review.description', {
          defaultValue:
            'Control account-level notifications for issues marked ready for review.',
        })}
      >
        <SettingsCheckbox
          id="review-requested-notifications"
          label={t('settings.accountNotifications.review.enabled.label', {
            defaultValue: 'Review request notifications',
          })}
          description={t(
            'settings.accountNotifications.review.enabled.helper',
            {
              defaultValue:
                'Notify me when a review tag is added to an issue. This includes review tags I add myself.',
            }
          )}
          checked={draft.review_requested_enabled}
          onChange={(checked) =>
            setDraft((prev) =>
              prev ? { ...prev, review_requested_enabled: checked } : prev
            )
          }
          disabled={mutation.isPending}
        />
      </SettingsCard>

      <SettingsSaveBar
        show={hasUnsavedChanges}
        saving={mutation.isPending}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
    </>
  );
}

export { AccountNotificationsSettingsSection as AccountNotificationsSettingsSectionContent };
