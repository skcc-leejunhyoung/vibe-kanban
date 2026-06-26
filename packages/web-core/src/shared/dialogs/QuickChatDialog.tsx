import { useEffect, useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import { FolderIcon, LightningIcon } from '@phosphor-icons/react';
import { Button } from '@vibe/ui/components/Button';
import { Textarea } from '@vibe/ui/components/Textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibe/ui/components/KeyboardDialog';
import { Alert, AlertDescription } from '@vibe/ui/components/Alert';
import type { ExecutorProfileId, Repo } from 'shared/types';
import {
  defineModal,
  getErrorMessage,
  type NoProps,
} from '@/shared/lib/modals';
import { repoApi, workspacesApi } from '@/shared/lib/api';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { AgentSelector } from '@/shared/components/tasks/AgentSelector';
import { FolderPickerDialog } from '@/shared/dialogs/shared/FolderPickerDialog';

/**
 * "Quick chat": a low-ceremony launcher to run an agent directly in an existing
 * folder. On send it creates an in-place workspace (no `vk/` worktree, no new
 * branch — the agent edits the real working tree) and navigates into the
 * standard workspace conversation view.
 */
const QuickChatDialogImpl = create<NoProps>(() => {
  const modal = useModal();
  const appNavigation = useAppNavigation();
  const { config, profiles } = useUserSystem();

  const [repo, setRepo] = useState<Repo | null>(null);
  const [prompt, setPrompt] = useState('');
  const [profileId, setProfileId] = useState<ExecutorProfileId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the agent to the user's configured executor once config loads.
  useEffect(() => {
    if (!profileId && config?.executor_profile) {
      setProfileId(config.executor_profile);
    }
  }, [config, profileId]);

  // Pre-fill the folder with the most recently used repo so the common case is
  // a single keystroke (type + send).
  useEffect(() => {
    if (!modal.visible || repo) return;
    let cancelled = false;
    repoApi
      .listRecent()
      .then((recent) => {
        if (!cancelled && recent[0]) setRepo(recent[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modal.visible, repo]);

  const close = () => {
    modal.resolve(null);
    modal.hide();
  };

  const pickFolder = async () => {
    setError(null);
    const path = await FolderPickerDialog.show({
      value: repo?.path,
      title: 'Select a folder',
      description: 'The agent runs directly in this folder.',
    });
    if (!path) return;
    try {
      const registered = await repoApi.register({ path });
      setRepo(registered);
    } catch (e) {
      setError(
        getErrorMessage(e) ||
          'That folder could not be opened. It must be a git repository.'
      );
    }
  };

  const canSend = Boolean(repo && profileId && prompt.trim() && !submitting);

  const handleSend = async () => {
    if (!repo || !profileId || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { workspace } = await workspacesApi.quickChat({
        repo_id: repo.id,
        executor_config: {
          executor: profileId.executor,
          variant: profileId.variant ?? null,
        },
        prompt: prompt.trim(),
        name: null,
      });
      modal.resolve(workspace.id);
      modal.hide();
      appNavigation.goToWorkspace(workspace.id);
    } catch (e) {
      setError(getErrorMessage(e) || 'Failed to start quick chat.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-base">
            <LightningIcon weight="fill" className="size-icon-sm text-brand" />
            Quick chat
          </DialogTitle>
          <DialogDescription>
            Run an agent in an existing folder — no new branch, no isolation.
            Edits land directly in your working tree.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-base">
          <div className="flex items-center gap-base">
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 flex-1 justify-start gap-1.5 text-xs"
              onClick={pickFolder}
              disabled={submitting}
            >
              <FolderIcon className="size-icon-xs shrink-0" />
              <span className="truncate">
                {repo ? repo.name : 'Select a folder…'}
              </span>
            </Button>
            <AgentSelector
              profiles={profiles}
              selectedExecutorProfile={profileId}
              onChange={setProfileId}
              disabled={submitting}
              className="flex-1"
            />
          </div>

          <Textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canSend) void handleSend();
              }
            }}
            placeholder="What can the agent help with?"
            className="min-h-[120px] rounded-sm"
          />

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={!canSend}>
            {submitting ? 'Starting…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const QuickChatDialog = defineModal<void, string | null>(
  QuickChatDialogImpl
);
