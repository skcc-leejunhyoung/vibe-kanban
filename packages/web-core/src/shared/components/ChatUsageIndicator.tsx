import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BaseCodingAgent } from 'shared/types';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { UsageProgress } from '@vibe/ui/components/UsageProgress';
import {
  ContextUsageGauge,
  type ContextUsageInfo,
} from '@vibe/ui/components/ContextUsageGauge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@vibe/ui/components/Dialog';
import { agentsApi } from '@/shared/lib/api';
import { formatBrowserDateTime } from '@/shared/lib/date';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { restoreDialogFocus } from '@vibe/ui/lib/dialog-keyboard';

const REFRESH_MS = 5 * 60 * 1000;

export function ChatUsageIndicator({
  agent,
  hostId: hostIdOverride,
  tokenUsageInfo,
}: {
  agent: BaseCodingAgent;
  hostId?: string | null;
  tokenUsageInfo?: ContextUsageInfo | null;
}) {
  const { t } = useTranslation('common');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const supportsUsage =
    agent === BaseCodingAgent.CLAUDE_CODE || agent === BaseCodingAgent.CODEX;
  const contextHostId = useHostId();
  const hostId = hostIdOverride === undefined ? contextHostId : hostIdOverride;
  const { data, isPending, isError } = useQuery({
    enabled: supportsUsage,
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
  const resetCreditExpirations = new Map<string | null, number>();
  for (const expiration of data?.reset_credit_expirations ?? []) {
    resetCreditExpirations.set(
      expiration,
      (resetCreditExpirations.get(expiration) ?? 0) + 1
    );
  }
  const unavailable = isError || data?.unavailable;
  const label = (value: string) => {
    if (value === 'Current session' || value === '5h')
      return t('agentUsage.session');
    if (value === 'Current week (all models)' || value === '7d')
      return t('agentUsage.weekly');
    if (value === 'Current week (Fable)') return t('agentUsage.fable');
    return value;
  };
  const resetDescription = (value: string | null, resetsAt?: string | null) => {
    if (resetsAt) return formatBrowserDateTime(resetsAt);
    const utc = value?.match(/^resets (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/);
    return utc
      ? formatBrowserDateTime(`${utc[1]}T${utc[2]}:00Z`)
      : value?.replace(/^resets (?:at )?/, '');
  };

  const content = (context: ReactNode) => (
    <span className="flex w-64 flex-col gap-base text-base">
      <span className="text-normal">{context}</span>
      {supportsUsage && isPending && <span>{t('states.loading')}</span>}
      {data?.windows.map((window) => (
        <UsageProgress
          key={window.label}
          label={label(window.label)}
          usedPercent={window.used_percent}
          detail={resetDescription(window.reset_description, window.resets_at)}
        />
      ))}
      {data?.reset_credits != null && (
        <span className="flex flex-col gap-1 text-sm text-low">
          <span>
            {t('agentUsage.resetCredits', { count: data.reset_credits })}
          </span>
          {[...resetCreditExpirations].map(([expiration, count]) => (
            <span key={expiration ?? 'never'}>
              {expiration === null
                ? t('agentUsage.resetCreditsNeverExpire', { count })
                : t('agentUsage.resetCreditsExpire', {
                    count,
                    date: formatBrowserDateTime(expiration),
                  })}
            </span>
          ))}
        </span>
      )}
      {unavailable && (
        <span className="text-low">
          {t(
            data?.windows.length || data?.reset_credits != null
              ? 'agentUsage.lastKnown'
              : data?.login_required
                ? 'agentUsage.loginRequired'
                : 'agentUsage.unavailable'
          )}
        </span>
      )}
      {data?.login_required &&
        (data.windows.length > 0 || data.reset_credits != null) && (
          <span className="text-low">{t('agentUsage.loginRequired')}</span>
        )}
    </span>
  );
  return (
    <ContextUsageGauge
      tokenUsageInfo={tokenUsageInfo}
      renderDetails={(trigger, context) => (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <Tooltip
            side="top"
            content={content(context)}
            className={dialogOpen ? 'hidden' : undefined}
          >
            <DialogTrigger asChild ref={triggerRef}>
              {trigger}
            </DialogTrigger>
          </Tooltip>
          <DialogContent
            className="max-w-sm p-double"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              restoreDialogFocus(triggerRef.current);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('contextUsage.label')}</DialogTitle>
            </DialogHeader>
            {content(context)}
          </DialogContent>
        </Dialog>
      )}
    />
  );
}
