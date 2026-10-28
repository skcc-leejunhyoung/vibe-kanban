import { useTranslation } from 'react-i18next';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import type { AutomationConnector } from '@/shared/lib/automationWorker';

export function GithubReviewScope({
  connector: c,
  workerEnabled,
  busy,
  onEdit,
}: {
  connector: AutomationConnector;
  workerEnabled: boolean;
  busy: boolean;
  onEdit: (connector: AutomationConnector) => void;
}) {
  const { t } = useTranslation('settings');
  const repositories =
    Array.isArray(c.config.reviewRepositories) &&
    c.config.reviewRepositories.length
      ? c.config.reviewRepositories.map(String)
      : [`${c.config.owner}/${c.config.repo}`];
  const reconciliation = c.config.reviewPrReconciliation as
    | {
        checkedAt: string;
        complete: boolean;
        open: Array<{
          repository: string;
          number: number;
          headSha: string | null;
          targets?: Array<{
            ruleId: string;
            connectorId: string;
            projectId: string;
            issueId: string;
            ready: boolean;
            error?: string;
          }>;
        }>;
        missing: Array<{
          repository: string;
          number: number;
          status: string;
        }>;
        errors: Array<{
          repository: string;
          number?: number;
          connectorId?: string;
          ruleId?: string;
          error: string;
        }>;
      }
    | undefined;
  return (
    <div className="space-y-2 rounded-sm border border-border p-3 text-sm">
      <div className="font-medium text-normal">{c.name}</div>
      <p>
        {t(
          'settings.automation.reviewScope',
          'Review requests monitored: {{repositories}}',
          {
            repositories:
              workerEnabled && c.enabled && c.config.reviewPrs
                ? repositories.join(', ')
                : t('settings.automation.reviewScopeNone', 'None (disabled)'),
          }
        )}
      </p>
      <p className="text-low">
        {t(
          'settings.automation.reviewScopeWarning',
          'Repositories outside this list are not monitored for review requests. Assigned issue filters apply only to the primary repository. Add a repository below using the existing credential; no organization-wide access is requested.'
        )}
      </p>
      <PrimaryButton
        variant="secondary"
        value={t(
          'settings.automation.editReviewScope',
          'Edit monitored repositories'
        )}
        onClick={() => onEdit(c)}
        disabled={busy}
      />
      {Array.isArray(c.config.prCommentErrors) &&
        c.config.prCommentErrors.map(
          (error: { repository: string; error: string }) => (
            <p className="text-warning" key={`activity:${error.repository}`}>
              {error.repository}: {error.error}
            </p>
          )
        )}
      {reconciliation && (
        <div className="space-y-1 text-low">
          <p>
            {t(
              'settings.automation.reviewReconciliation',
              'Last review check: {{checkedAt}} · Open: {{open}} · Untracked or unlinked: {{missing}} · Complete: {{complete}}',
              {
                checkedAt: reconciliation.checkedAt,
                open: reconciliation.open.length,
                missing: reconciliation.missing.length,
                complete: String(reconciliation.complete),
              }
            )}
          </p>
          {reconciliation.open.map((pr) => (
            <p key={`${pr.repository}#${pr.number}`}>
              {pr.repository}#{pr.number} · {pr.headSha?.slice(0, 12) || '—'}
            </p>
          ))}
          {reconciliation.open.flatMap((pr) =>
            (pr.targets || [])
              .filter((target) => target.error)
              .map((target) => (
                <p
                  className="text-warning"
                  key={`${pr.repository}#${pr.number}:${target.ruleId}:${target.connectorId}:${target.projectId}`}
                >
                  {pr.repository}#{pr.number} · {target.connectorId}:{' '}
                  {target.error}
                </p>
              ))
          )}
          {reconciliation.missing.map((pr) => (
            <p className="text-warning" key={`${pr.repository}#${pr.number}`}>
              {pr.repository}#{pr.number} · {pr.status}
            </p>
          ))}
          {reconciliation.errors.map((error) => (
            <p
              className="text-warning"
              key={`${error.repository}:${error.number}:${error.connectorId}:${error.ruleId}`}
            >
              {error.repository}: {error.error}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
