import type { Workspace } from 'shared/types';
import { Pages, getPageActions } from '@/shared/command-bar/actions/pages';
import type { StaticPageId, ResolvedGroup } from '@/shared/types/commandBar';
import {
  resolveLabel,
  isActionVisible,
  type ActionVisibilityContext,
} from '@/shared/types/actions';
import { fuzzySearchMatch } from '@vibe/ui/lib/search';

// Derive injectable pages from Pages - all child pages of root
const INJECTABLE_PAGE_IDS = (Object.keys(Pages) as StaticPageId[]).filter(
  (id) => id !== 'root' && Pages[id].parent === 'root'
);

export function injectSearchMatches(
  searchQuery: string,
  ctx: ActionVisibilityContext,
  workspace: Workspace | undefined
): ResolvedGroup[] {
  return INJECTABLE_PAGE_IDS.reduce<ResolvedGroup[]>((groups, id) => {
    const page = Pages[id];

    // Check page visibility condition
    if (page.isVisible && !page.isVisible(ctx)) return groups;

    const items = getPageActions(id)
      .filter((a) => isActionVisible(a, ctx))
      .filter((a) => {
        const label = resolveLabel(a, workspace);
        return (
          fuzzySearchMatch(label, searchQuery) ||
          fuzzySearchMatch(a.id, searchQuery) ||
          (a.keywords?.some((kw) => fuzzySearchMatch(kw, searchQuery)) ?? false)
        );
      })
      .map((action) => ({ type: 'action' as const, action }));

    if (items.length) groups.push({ label: page.title || id, items });
    return groups;
  }, []);
}
