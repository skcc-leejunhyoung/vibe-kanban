import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create, useModal } from '@ebay/nice-modal-react';
import { useTranslation } from 'react-i18next';
import type { IssueTag } from 'shared/remote-types';
import { defineModal } from '@/shared/lib/modals';
import { CommandDialog } from '@vibe/ui/components/Command';
import {
  MultiSelectCommandBar,
  type MultiSelectOption,
} from '@vibe/ui/components/MultiSelectCommandBar';
import { ProjectProvider } from '@/shared/providers/remote/ProjectProvider';
import { useProjectContext } from '@/shared/hooks/useProjectContext';

export type TagSelectionMode = 'add' | 'remove';

export interface TagSelectionDialogProps {
  projectId: string;
  issueIds: string[];
  mode: TagSelectionMode;
}

/**
 * Decide what toggling one tag does across the selected issues. `links` are
 * that tag's issue_tags rows on the selected issues. Remove mode, or a tag
 * every selected issue already has, clears it from all of them; otherwise the
 * tag is added to the issues that lack it.
 */
export function planTagToggle(
  links: IssueTag[],
  issueIds: string[],
  mode: TagSelectionMode
): { removeLinkIds: string[]; addIssueIds: string[] } {
  if (mode === 'remove' || links.length === issueIds.length) {
    return { removeLinkIds: links.map((link) => link.id), addIssueIds: [] };
  }
  const tagged = new Set(links.map((link) => link.issue_id));
  return {
    removeLinkIds: [],
    addIssueIds: issueIds.filter((issueId) => !tagged.has(issueId)),
  };
}

function TagSelectionContent({
  issueIds,
  mode,
}: Omit<TagSelectionDialogProps, 'projectId'>) {
  const { t } = useTranslation('common');
  const modal = useModal();
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const { tags, getTagsForIssue, insertIssueTag, removeIssueTag } =
    useProjectContext();
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (modal.visible) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      setSearch('');
    }
  }, [modal.visible]);

  // tag id -> its issue_tags rows on the selected issues
  const linksByTagId = useMemo(() => {
    const map = new Map<string, IssueTag[]>();
    for (const issueId of issueIds) {
      for (const link of getTagsForIssue(issueId)) {
        map.set(link.tag_id, [...(map.get(link.tag_id) ?? []), link]);
      }
    }
    return map;
  }, [issueIds, getTagsForIssue]);

  const options: MultiSelectOption<string>[] = useMemo(
    () =>
      tags
        .filter((tag) => mode === 'add' || linksByTagId.has(tag.id))
        .map((tag) => {
          const count = linksByTagId.get(tag.id)?.length ?? 0;
          return {
            value: tag.id,
            label: tag.name,
            renderOption: () => (
              <div className="flex items-center gap-base">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: `hsl(${tag.color})` }}
                />
                <span>{tag.name}</span>
                {issueIds.length > 1 && count > 0 && (
                  <span className="text-low">{`${count}/${issueIds.length}`}</span>
                )}
              </div>
            ),
          };
        }),
    [tags, mode, linksByTagId, issueIds.length]
  );

  // Add mode checks tags every selected issue has; remove mode lists only
  // tags present on some issue, so a checkmark would add nothing there.
  const selectedValues = useMemo(
    () =>
      mode === 'add'
        ? tags
            .filter(
              (tag) => linksByTagId.get(tag.id)?.length === issueIds.length
            )
            .map((tag) => tag.id)
        : [],
    [mode, tags, linksByTagId, issueIds.length]
  );

  const handleToggle = useCallback(
    (tagId: string) => {
      const { removeLinkIds, addIssueIds } = planTagToggle(
        linksByTagId.get(tagId) ?? [],
        issueIds,
        mode
      );
      for (const id of removeLinkIds) removeIssueTag(id);
      for (const issueId of addIssueIds) {
        insertIssueTag({ issue_id: issueId, tag_id: tagId });
      }
      setSearch('');
    },
    [linksByTagId, issueIds, mode, insertIssueTag, removeIssueTag]
  );

  const handleClose = useCallback(() => {
    modal.hide();
  }, [modal]);

  const handleCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    previousFocusRef.current?.focus();
  }, []);

  return (
    <CommandDialog
      open={modal.visible}
      onOpenChange={(open) => !open && modal.hide()}
      onCloseAutoFocus={handleCloseAutoFocus}
    >
      <MultiSelectCommandBar
        title={
          mode === 'add'
            ? t('kanban.addTags', 'Add tags...')
            : t('kanban.removeTags', 'Remove tags...')
        }
        options={options}
        selectedValues={selectedValues}
        onToggle={handleToggle}
        onClose={handleClose}
        search={search}
        onSearchChange={setSearch}
      />
    </CommandDialog>
  );
}

const TagSelectionDialogImpl = create<TagSelectionDialogProps>(
  ({ projectId, issueIds, mode }) => (
    <ProjectProvider projectId={projectId}>
      <TagSelectionContent issueIds={issueIds} mode={mode} />
    </ProjectProvider>
  )
);

export const TagSelectionDialog = defineModal<TagSelectionDialogProps, void>(
  TagSelectionDialogImpl
);
