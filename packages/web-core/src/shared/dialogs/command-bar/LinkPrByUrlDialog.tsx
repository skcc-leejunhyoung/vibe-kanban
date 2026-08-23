import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
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
import { create, useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/shared/lib/modals';
import { issuePrsApi } from '@/shared/lib/api';
import type { PullRequestDetail } from 'shared/types';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { getHostRequestScopeQueryKey } from '@/shared/lib/hostRequestScope';

/**
 * Prompt the user to paste a pull-request URL and, once it resolves to a real
 * PR, resolve the dialog with that URL. Shown as the manual fallback when
 * branch-based auto-matching can't find a PR to link. Resolves `undefined` when
 * dismissed.
 */
interface LinkPrByUrlDialogProps {
  hostId?: string | null;
}

const LinkPrByUrlDialogImpl = create<LinkPrByUrlDialogProps>((props) => {
  const modal = useModal();
  const routeHostId = useHostId();
  const hostId = props.hostId === undefined ? routeHostId : props.hostId;
  const { t } = useTranslation('tasks');

  const [prUrl, setPrUrl] = useState('');
  const [debouncedUrl, setDebouncedUrl] = useState('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setUrlNow = useCallback((value: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setDebouncedUrl(value.trim());
  }, []);

  const handleUrlChange = useCallback((value: string) => {
    setPrUrl(value);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedUrl(value.trim());
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const {
    data: prInfoResult,
    isLoading: isLoadingPrInfo,
    error: prInfoError,
  } = useQuery({
    queryKey: ['pr-info', debouncedUrl, getHostRequestScopeQueryKey(hostId)],
    queryFn: () => issuePrsApi.getPrInfo(debouncedUrl, hostId),
    enabled: modal.visible && debouncedUrl.length > 0,
  });

  const prInfo = useMemo<PullRequestDetail | null>(
    () => (prInfoResult?.success ? prInfoResult.data : null),
    [prInfoResult]
  );

  const showError =
    debouncedUrl.length > 0 &&
    !isLoadingPrInfo &&
    (!!prInfoError || (!!prInfoResult && !prInfoResult.success));

  const resolveWith = (value: string | undefined) => {
    modal.resolve(value);
    modal.hide();
  };

  const canLink = !!prInfo && !isLoadingPrInfo;

  return (
    <Dialog
      open={modal.visible}
      onOpenChange={(open) => !open && resolveWith(undefined)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('linkPrByUrl.title', 'Link pull request by URL')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'linkPrByUrl.description',
              'Paste the URL of the pull request to map to this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-2">
            <Label>{t('linkPrToIssue.urlLabel', 'Pull Request URL')}</Label>
            <Input
              autoFocus
              placeholder={t(
                'linkPrToIssue.urlPlaceholder',
                'https://github.com/owner/repo/pull/123'
              )}
              value={prUrl}
              onChange={(e) => handleUrlChange(e.target.value)}
              onBlur={() => setUrlNow(prUrl)}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData('text').trim();
                if (pasted) {
                  e.preventDefault();
                  setPrUrl(pasted);
                  setUrlNow(pasted);
                }
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  canLink
                ) {
                  e.preventDefault();
                  resolveWith(prInfo!.url);
                }
              }}
            />
          </div>

          {isLoadingPrInfo && (
            <div className="text-sm text-muted-foreground">
              {t('linkPrToIssue.loadingPrInfo', 'Loading PR info...')}
            </div>
          )}

          {showError && (
            <div className="text-sm text-destructive">
              {t(
                'linkPrToIssue.invalidUrl',
                'Could not load PR info from this URL'
              )}
            </div>
          )}

          {prInfo && (
            <div className="rounded-md border p-3 space-y-1">
              <span className="text-sm font-medium truncate">
                #{String(prInfo.number)}
                {prInfo.title ? `: ${prInfo.title}` : ''}
              </span>
              {prInfo.base_branch && (
                <div className="text-xs text-muted-foreground">
                  {t('linkPrToIssue.baseBranch', 'Base:')} {prInfo.base_branch}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => resolveWith(undefined)}
          >
            {t('common:buttons.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            disabled={!canLink}
            onClick={() => prInfo && resolveWith(prInfo.url)}
          >
            {t('linkPrToIssue.linkPr', 'Link PR')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const LinkPrByUrlDialog = defineModal<
  LinkPrByUrlDialogProps,
  string | undefined
>(LinkPrByUrlDialogImpl);
