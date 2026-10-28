import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { BaseCodingAgent } from 'shared/types';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { agentsApi } from '@/shared/lib/api';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';

const REFRESH_MS = 5 * 60 * 1000;

export function AgentUsageTooltip({
  agent,
  name,
  hostId: hostIdOverride,
  children,
}: {
  agent: BaseCodingAgent;
  name: string;
  hostId?: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation('common');
  const contextHostId = useHostId();
  const hostId = hostIdOverride === undefined ? contextHostId : hostIdOverride;
  const { data, isPending, isError } = useQuery({
    queryKey: ['agentUsage', getHostRequestScopeQueryKey(hostId), agent],
    queryFn: () => agentsApi.getUsage(agent, hostId),
    staleTime: REFRESH_MS,
    refetchInterval: (query) =>
      Math.max(
        REFRESH_MS,
        query.state.data
          ? new Date(query.state.data.next_refresh_at).getTime() - Date.now()
          : REFRESH_MS
      ),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const unavailable = isError || data?.unavailable;
  const label = (value: string) => {
    if (value === 'Current session' || value === '5h')
      return t('agentUsage.session');
    if (value === 'Current week (all models)' || value === '7d')
      return t('agentUsage.weekly');
    return value;
  };

  return (
    <Tooltip
      side="top"
      content={
        <span className="flex w-64 flex-col gap-base text-base">
          <span className="font-medium text-high">{name}</span>
          <span className="text-sm text-low">
            {t('agentUsage.hostAccount')}
          </span>
          {isPending && <span>{t('states.loading')}</span>}
          {data?.windows.map((window) => (
            <span key={window.label} className="flex flex-col gap-1">
              <span className="flex justify-between gap-base">
                <span>{label(window.label)}</span>
                <span>
                  {t('agentUsage.used', {
                    percent: window.used_percent.toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    }),
                  })}
                </span>
              </span>
              <span
                role="progressbar"
                aria-label={label(window.label)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={window.used_percent}
                className="h-1 overflow-hidden rounded-sm bg-secondary"
              >
                <span
                  className="block h-full bg-brand"
                  style={{ width: `${window.used_percent}%` }}
                />
              </span>
              {window.reset_description && (
                <span className="text-sm text-low">
                  {window.reset_description}
                </span>
              )}
            </span>
          ))}
          {unavailable && (
            <span className="text-low">
              {t(
                data?.windows.length
                  ? 'agentUsage.lastKnown'
                  : 'agentUsage.unavailable'
              )}
            </span>
          )}
          {data?.updated_at && (
            <span className="text-sm text-low">
              {t('agentUsage.updated', {
                time: new Date(data.updated_at).toLocaleTimeString(),
              })}
            </span>
          )}
          {unavailable && data && (
            <span className="text-sm text-low">
              {t('agentUsage.retryAt', {
                time: new Date(data.next_refresh_at).toLocaleTimeString(),
              })}
            </span>
          )}
        </span>
      }
    >
      <span tabIndex={0} aria-label={name} className="inline-flex shrink-0">
        {children}
      </span>
    </Tooltip>
  );
}
