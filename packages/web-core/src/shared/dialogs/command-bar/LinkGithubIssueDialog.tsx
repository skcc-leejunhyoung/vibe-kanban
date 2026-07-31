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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = useMemo<MachineTarget>(
    () =>
      props.hostId
        ? {
            kind: 'remote',
            id: props.hostId,
            apiHostId: props.hostId,
            label: props.hostId,
          }
        : { kind: 'local', id: 'local', apiHostId: null, label: 'Local' },
    [props.hostId]
  );
  const client = useMemo(
    () => createMachineClient(props.runtime, target),
    [props.runtime, target]
  );

  useEffect(() => {
    client
      .getAutomationState()
      .then((state) => {
        const syncRules = state.rules.filter(
          (rule) => rule.enabled && rule.kind === 'github_issue_sync'
        );
        setRules(syncRules);
        setRuleId(syncRules[0]?.id ?? '');
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason))
      );
  }, [client]);

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
            variant="outline"
            onClick={() => modal.hide()}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !ruleId || (mode === 'existing' && !url.trim())}
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
