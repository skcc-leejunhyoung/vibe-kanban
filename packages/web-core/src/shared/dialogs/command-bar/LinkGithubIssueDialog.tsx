import { useEffect, useMemo, useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import { Label } from '@vibe/ui/components/Label';
import { defineModal } from '@/shared/lib/modals';
import {
  createMachineClient,
  type MachineTarget,
} from '@/shared/lib/machineClient';
import type { AppRuntime } from '@/shared/hooks/useAppRuntime';
import type { AutomationRule } from '@/shared/lib/automationWorker';

export interface LinkGithubIssueDialogProps {
  runtime: AppRuntime;
  hostId: string | null;
  projectId: string;
  hosts: { id: string; name: string }[];
  issueId: string;
  title: string;
  description: string | null;
  statusId: string;
  updatedAt: string;
}

function LinkGithubIssueContent(props: LinkGithubIssueDialogProps) {
  const modal = useModal();
  const [mode, setMode] = useState<'existing' | 'create'>('create');
  const [url, setUrl] = useState('');
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [ruleId, setRuleId] = useState('');
  const [selectedHostId, setSelectedHostId] = useState(props.hostId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = useMemo<MachineTarget>(
    () =>
      selectedHostId
        ? {
            kind: 'remote',
            id: selectedHostId,
            apiHostId: selectedHostId,
            label:
              props.hosts.find((host) => host.id === selectedHostId)?.name ??
              selectedHostId,
          }
        : { kind: 'local', id: 'local', apiHostId: null, label: 'Local' },
    [props.hosts, selectedHostId]
  );
  const client = useMemo(
    () => createMachineClient(props.runtime, target),
    [props.runtime, target]
  );

  useEffect(() => {
    if (
      props.runtime === 'remote' &&
      selectedHostId &&
      !props.hosts.some((host) => host.id === selectedHostId)
    ) {
      setSelectedHostId('');
    }
  }, [props.hosts, props.runtime, selectedHostId]);

  useEffect(() => {
    if (props.runtime === 'remote' && !selectedHostId) {
      setRules([]);
      setRuleId('');
      setError(null);
      return;
    }
    let cancelled = false;
    setRules([]);
    setRuleId('');
    setError(null);
    client
      .getAutomationState()
      .then((state) => {
        if (cancelled) return;
        const syncRules = state.rules.filter((rule) => {
          if (!rule.enabled || rule.kind !== 'github_issue_sync') return false;
          const vibeConnectorId = String(rule.config?.vibeConnectorId ?? '');
          const vibeConnector = state.connectors.find(
            (connector) => connector.id === vibeConnectorId
          );
          return vibeConnector?.config.projectId === props.projectId;
        });
        setRules(syncRules);
        setRuleId(syncRules[0]?.id ?? '');
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, props.projectId, props.runtime, selectedHostId]);

  const submit = async () => {
    if (!ruleId || (mode === 'existing' && !url.trim())) return;
    setBusy(true);
    setError(null);
    try {
      await client.linkGithubIssue({
        ruleId,
        mode,
        issueId: props.issueId,
        url: mode === 'existing' ? url.trim() : undefined,
        title: props.title,
        description: props.description,
        statusId: props.statusId,
        vibeUpdatedAt: props.updatedAt,
      });
      modal.hide();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={modal.visible} onOpenChange={(open) => !open && modal.hide()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link GitHub issue</DialogTitle>
          <DialogDescription>
            Link an existing issue or create one from this Vibe issue.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {props.runtime === 'remote' && (
            <div className="space-y-2">
              <Label htmlFor="github-automation-host">Automation host</Label>
              <select
                id="github-automation-host"
                value={selectedHostId}
                onChange={(event) => {
                  setRules([]);
                  setRuleId('');
                  setError(null);
                  setSelectedHostId(event.target.value);
                }}
                disabled={busy}
                className="w-full rounded border border-border bg-secondary px-3 py-2 text-sm"
              >
                <option value="">Select an online host</option>
                {props.hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                  </option>
                ))}
              </select>
              {!props.hosts.length && (
                <p className="text-sm text-muted-foreground">
                  No online host is available.
                </p>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === 'create' ? 'default' : 'outline'}
              onClick={() => setMode('create')}
            >
              Create and link
            </Button>
            <Button
              type="button"
              variant={mode === 'existing' ? 'default' : 'outline'}
              onClick={() => setMode('existing')}
            >
              Link existing
            </Button>
          </div>
          {rules.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="github-sync-rule">Automation rule</Label>
              <select
                id="github-sync-rule"
                value={ruleId}
                onChange={(event) => setRuleId(event.target.value)}
                className="w-full rounded border border-border bg-secondary px-3 py-2 text-sm"
              >
                {rules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {mode === 'existing' && (
            <div className="space-y-2">
              <Label htmlFor="github-issue-url">GitHub issue URL</Label>
              <Input
                id="github-issue-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/owner/repo/issues/123"
              />
            </div>
          )}
          {!rules.length && !error && (
            <p className="text-sm text-muted-foreground">
              Enable and configure a GitHub Issue sync rule in Automation
              settings first.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => modal.hide()}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            onClick={submit}
            disabled={
              busy ||
              (props.runtime === 'remote' && !selectedHostId) ||
              !ruleId ||
              (mode === 'existing' && !url.trim())
            }
          >
            {busy
              ? 'Working…'
              : mode === 'create'
                ? 'Create and link'
                : 'Link issue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LinkGithubIssueDialogImpl = create<LinkGithubIssueDialogProps>(
  (props) => <LinkGithubIssueContent {...props} />
);

export const LinkGithubIssueDialog = defineModal<
  LinkGithubIssueDialogProps,
  void
>(LinkGithubIssueDialogImpl);
