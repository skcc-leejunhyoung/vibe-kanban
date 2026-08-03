import { memo, useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CopyIcon,
  CaretDownIcon,
  CaretRightIcon,
  FileIcon,
  GithubLogoIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { FileDiff, WorkerPoolContextProvider } from '@pierre/diffs/react';
import type { DiffLineAnnotation, AnnotationSide } from '@pierre/diffs';
const WorkerUrl = new URL(
  '@pierre/diffs/worker/worker-portable.js',
  import.meta.url
).href;
import { sortDiffs } from '@/shared/lib/fileTreeUtils';
import { useChangesView } from '@/shared/hooks/useChangesView';
import {
  useDiffs,
  useShowGitHubComments,
  useGetGitHubCommentsForFile,
  useGitHubCommentsRepoId,
} from '@/shared/stores/useWorkspaceDiffStore';
import {
  useDiffViewMode,
  useWrapTextDiff,
  useIgnoreWhitespaceDiff,
} from '@/shared/stores/useDiffViewStore';
import { useTheme } from '@/shared/hooks/useTheme';
import { getActualTheme } from '@/shared/lib/theme';
import { useReview, type ReviewDraft } from '@/shared/hooks/useReview';
import {
  transformDiffToFileDiffMetadata,
  transformCommentsToAnnotations,
  type CommentAnnotation,
} from '@/shared/lib/diffDataAdapter';
import { DiffSide } from '@/shared/types/diff';
import { isRealMobileDevice } from '@/shared/hooks/useIsMobile';
import { useOpenInEditor } from '@/shared/hooks/useOpenInEditor';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { OpenInIdeButton } from '@/shared/components/OpenInIdeButton';
import { CopyButton } from '@/shared/components/CopyButton';
import { writeClipboardViaBridge } from '@/shared/lib/clipboard';
import { getFileIcon } from '@/shared/lib/fileTypeIcon';
import { stripLineEnding, splitLines } from '@/shared/lib/string';
import { ReviewCommentRenderer } from './ReviewCommentRenderer';
import { GitHubCommentRenderer } from './GitHubCommentRenderer';
import { CommentWidgetLine } from './CommentWidgetLine';
import { CommitSelector } from './CommitSelector';
import type { Diff } from 'shared/types';
import {
  findDiffByPath,
  getDiffKey,
  getDiffPath,
  getDiffStyle,
  getReviewCommentsForDiff,
  getReviewWidgetKey,
  groupDiffsByRepo,
  hasGitHubCommentsForDiff,
  resolveSelectedDiff,
  shouldStackChangesPanel,
  shouldDeferDiffLoad,
  splitFilePath,
} from './changesPanelModel';

function workerFactory() {
  return new Worker(WorkerUrl, { type: 'module' });
}

const POOL_OPTIONS = { workerFactory, poolSize: 3 };
const HIGHLIGHTER_OPTIONS = {
  theme: { dark: 'github-dark', light: 'github-light' } as const,
  langs: [] as string[],
};

const IS_MOBILE = isRealMobileDevice();
const NOOP = () => {};

function MiddleEllipsisPath({
  path,
  className = '',
}: {
  path: string;
  className?: string;
}) {
  const { directory, fileName } = splitFilePath(path);

  return (
    <span
      className={`min-w-0 max-w-full flex flex-1 items-baseline overflow-hidden font-mono ${className}`}
      title={path}
    >
      {directory && (
        <>
          <span className="min-w-0 flex-1 truncate text-low">{directory}</span>
          <span className="shrink-0 text-low">/</span>
        </>
      )}
      <span
        className={`min-w-0 shrink-0 truncate font-medium ${
          directory ? 'max-w-[calc(100%-0.75rem)]' : 'max-w-full'
        }`}
      >
        {fileName}
      </span>
    </span>
  );
}

const PIERRE_DIFFS_THEME_CSS = `
  :host {
    position: relative;
  }

  [data-diffs-header] {
    background-color: hsl(var(--bg-primary));
    min-height: 40px;
    position: sticky;
    top: 0;
    z-index: 10;
    padding-inline: 12px;
    border-radius: 4px 4px 0 0;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.75rem;
    line-height: 1rem;
  }

  [data-diffs-header]::before {
    content: '';
    position: absolute;
    top: -6px;
    left: -4px;
    right: -4px;
    height: 6px;
    background-color: hsl(var(--bg-secondary));
  }

  [data-diffs-header] [data-additions-count],
  [data-diffs-header] [data-deletions-count] {
    display: none;
  }

  [data-diffs-header] [data-change-icon] {
    display: none;
  }

  [data-header-content] {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }

  [data-header-content] > slot[name='header-prefix'] {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  [data-header-content] [data-prev-name],
  [data-header-content] [data-rename-icon],
  [data-header-content] [data-title] {
    display: none;
  }

  [data-diffs-header] [data-metadata] {
    flex: 0 0 auto;
    min-width: 0;
    font-family: inherit;
    font-size: 0.75rem;
    gap: 8px;
  }

  [data-code] {
    border-radius: 0 0 4px 4px;
  }

  [data-separator="line-info"][data-separator-first] {
    margin-top: 4px;
  }
  [data-separator="line-info"][data-separator-last] {
    margin-bottom: 4px;
  }

  [data-indicators='classic'] [data-column-content] {
    position: relative;
    padding-inline-start: 34px;
  }

  [data-indicators='classic'] [data-line-type='change-addition'] [data-column-content]::before,
  [data-indicators='classic'] [data-line-type='change-deletion'] [data-column-content]::before {
    left: 22px;
  }

  [data-hover-slot] {
    right: auto;
    left: calc(var(--diffs-column-number-width, 3ch) - 25px);
    width: 22px;
  }

  [data-annotation-content] {
    grid-column: 1 / -1;
    left: 0;
    width: var(--diffs-column-width, 100%);
    max-width: 100%;
  }
  
  [data-line-annotation] {
    grid-column: 1 / -1;
  }

  [data-code] {
    padding-bottom: 0;
  }
  [data-code]::-webkit-scrollbar {
    height: 8px;
    background: transparent;
  }
  [data-code]::-webkit-scrollbar-track {
    background: transparent;
  }
  [data-code]::-webkit-scrollbar-thumb {
    background-color: transparent;
    border-radius: 4px;
  }
  [data-code]:hover::-webkit-scrollbar-thumb {
    background-color: hsl(var(--text-low) / 0.3);
  }

  [data-diff][data-theme-type='light'] {
    --diffs-gap-style: none;
    --diffs-light-bg: hsl(var(--bg-primary));
    --diffs-bg-context-override: hsl(var(--bg-primary));
    --diffs-bg-separator-override: hsl(var(--bg-primary));
    --diffs-light-addition-color: hsl(160, 77%, 35%);
    --diffs-bg-addition-override: hsl(160, 77%, 88%);
    --diffs-bg-addition-number-override: hsl(160, 77%, 85%);
    --diffs-bg-addition-hover-override: hsl(160, 77%, 82%);
    --diffs-light-deletion-color: hsl(10, 100%, 40%);
    --diffs-bg-deletion-override: hsl(10, 100%, 90%);
    --diffs-bg-deletion-number-override: hsl(10, 100%, 87%);
    --diffs-bg-deletion-hover-override: hsl(10, 100%, 84%);
    --diffs-fg-number-override: hsl(var(--text-low));
  }

  [data-diff][data-theme-type='dark'] {
    --diffs-gap-style: none;
    --diffs-dark-bg: hsl(var(--bg-panel));
    --diffs-bg-context-override: hsl(var(--bg-panel));
    --diffs-bg-separator-override: hsl(var(--bg-panel));
    --diffs-bg-hover-override: hsl(0, 0%, 22%);
    --diffs-dark-addition-color: hsl(130, 50%, 50%);
    --diffs-bg-addition-override: hsl(130, 30%, 20%);
    --diffs-bg-addition-number-override: hsl(130, 30%, 18%);
    --diffs-bg-addition-hover-override: hsl(130, 30%, 25%);
    --diffs-dark-deletion-color: hsl(12, 50%, 55%);
    --diffs-bg-deletion-override: hsl(12, 30%, 18%);
    --diffs-bg-deletion-number-override: hsl(12, 30%, 16%);
    --diffs-bg-deletion-hover-override: hsl(12, 30%, 23%);
    --diffs-fg-number-override: hsl(var(--text-low));
  }
`;

type ExtendedCommentAnnotation =
  | CommentAnnotation
  | { type: 'draft'; draft: ReviewDraft; widgetKey: string };

function mapSideToAnnotationSide(side: DiffSide): AnnotationSide {
  return side === DiffSide.Old ? 'deletions' : 'additions';
}

function mapAnnotationSideToSplitSide(side: AnnotationSide): DiffSide {
  return side === 'deletions' ? DiffSide.Old : DiffSide.New;
}

function getLineContent(
  content: string | null,
  lineNumber: number
): string | undefined {
  if (!content) return undefined;
  const lines = splitLines(content);
  const index = lineNumber - 1;
  if (index < 0 || index >= lines.length) return undefined;
  return stripLineEnding(lines[index]);
}

function getCodeLineForComment(
  diff: Diff,
  lineNumber: number,
  side: DiffSide
): string | undefined {
  const content = side === DiffSide.Old ? diff.oldContent : diff.newContent;
  return getLineContent(content, lineNumber);
}

function scrollToLineInDiff(fileEl: HTMLElement, lineNumber: number): boolean {
  const container = fileEl.querySelector('diffs-container');
  const shadowRoot = container?.shadowRoot ?? null;
  if (shadowRoot) {
    const lineEl = shadowRoot.querySelector(`[data-line="${lineNumber}"]`);
    if (lineEl instanceof HTMLElement) {
      lineEl.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      return true;
    }
  }
  return false;
}

const DIFF_CACHE_MAX = 200;

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}
  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }
  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(key, val);
  }
  clear(): void {
    this.map.clear();
  }
}

const fileDiffCache = new LruCache<
  string,
  {
    diff: Diff;
    ignoreWhitespace: boolean;
    result: ReturnType<typeof transformDiffToFileDiffMetadata>;
  }
>(DIFF_CACHE_MAX);

function getCachedFileDiffMetadata(diff: Diff, ignoreWhitespace: boolean) {
  const path = diff.newPath || diff.oldPath || '';
  const cached = fileDiffCache.get(path);
  if (
    cached &&
    cached.diff === diff &&
    cached.ignoreWhitespace === ignoreWhitespace
  ) {
    return cached.result;
  }
  const result = transformDiffToFileDiffMetadata(diff, { ignoreWhitespace });
  fileDiffCache.set(path, { diff, ignoreWhitespace, result });
  return result;
}

interface DiffFileItemProps {
  diff: Diff;
  workspaceId: string;
}

const DiffFileItem = memo(function DiffFileItem({
  diff,
  workspaceId,
}: DiffFileItemProps) {
  const { t } = useTranslation('common');
  const filePath = diff.newPath || diff.oldPath || '';

  const { theme } = useTheme();
  const actualTheme = getActualTheme(theme);
  const globalMode = useDiffViewMode();
  const wrapText = useWrapTextDiff();
  const ignoreWhitespace = useIgnoreWhitespaceDiff();

  const { comments, drafts, setDraft, addComment } = useReview();
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const showGitHubComments = useShowGitHubComments();
  const getGitHubCommentsForFile = useGetGitHubCommentsForFile();
  const gitHubCommentsRepoId = useGitHubCommentsRepoId();

  const openInEditor = useOpenInEditor(workspaceId);

  const fileDiffMetadata = useMemo(
    () => getCachedFileDiffMetadata(diff, ignoreWhitespace),
    [diff, ignoreWhitespace]
  );

  const commentsForFile = useMemo(
    () => getReviewCommentsForDiff(comments, diff),
    [comments, diff]
  );

  const githubCommentsForFile = useMemo(
    () =>
      showGitHubComments && hasGitHubCommentsForDiff(diff, gitHubCommentsRepoId)
        ? getGitHubCommentsForFile(filePath)
        : [],
    [
      showGitHubComments,
      diff.repoId,
      gitHubCommentsRepoId,
      getGitHubCommentsForFile,
      filePath,
    ]
  );

  const annotations = useMemo(() => {
    const base = transformCommentsToAnnotations(
      commentsForFile,
      githubCommentsForFile,
      filePath
    ) as DiffLineAnnotation<ExtendedCommentAnnotation>[];

    const draftAnns: DiffLineAnnotation<ExtendedCommentAnnotation>[] = [];
    Object.entries(drafts).forEach(([key, draft]) => {
      if (
        !draft ||
        draft.repoId !== diff.repoId ||
        draft.filePath !== filePath
      ) {
        return;
      }
      draftAnns.push({
        side: mapSideToAnnotationSide(draft.side),
        lineNumber: draft.lineNumber,
        metadata: { type: 'draft', draft, widgetKey: key },
      });
    });

    return base.length > 0 || draftAnns.length > 0
      ? [...base, ...draftAnns]
      : undefined;
  }, [commentsForFile, githubCommentsForFile, filePath, diff.repoId, drafts]);

  const handleLineClick = useCallback(
    (props: { lineNumber: number; annotationSide: AnnotationSide }) => {
      const { lineNumber, annotationSide } = props;
      const splitSide = mapAnnotationSideToSplitSide(annotationSide);
      const widgetKey = getReviewWidgetKey(diff, splitSide, lineNumber);
      if (draftsRef.current[widgetKey]) return;

      const codeLine = getCodeLineForComment(diff, lineNumber, splitSide);
      setDraft(widgetKey, {
        repoId: diff.repoId,
        filePath,
        side: splitSide,
        lineNumber,
        text: '',
        ...(codeLine !== undefined ? { codeLine } : {}),
      });
    },
    [filePath, diff, setDraft]
  );

  const options = useMemo(
    () => ({
      diffStyle: getDiffStyle(globalMode),
      diffIndicators: 'classic' as const,
      themeType: actualTheme,
      overflow: wrapText ? ('wrap' as const) : ('scroll' as const),
      hunkSeparators: 'line-info' as const,
      enableHoverUtility: true,
      onLineClick: handleLineClick,
      theme: { dark: 'github-dark', light: 'github-light' } as const,
      unsafeCSS: PIERRE_DIFFS_THEME_CSS,
    }),
    [globalMode, actualTheme, wrapText, handleLineClick]
  );

  const handleCopyFilePath = useCallback(() => {
    void writeClipboardViaBridge(filePath);
  }, [filePath]);

  const handleOpenInIde = useCallback(() => {
    openInEditor({ filePath, repoId: diff.repoId ?? undefined });
  }, [openInEditor, filePath, diff.repoId]);

  const githubCommentCount = githubCommentsForFile.length;

  const additions = diff.additions ?? 0;
  const deletions = diff.deletions ?? 0;

  const renderHeaderMetadata = useCallback(
    () => (
      <div
        className="flex items-center gap-2 shrink-0 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <CopyButton
          onCopy={handleCopyFilePath}
          disabled={false}
          iconSize="size-icon-xs"
          icon={CopyIcon}
        />
        {(additions > 0 || deletions > 0) && (
          <span className="inline-flex items-center gap-1 font-mono">
            {additions > 0 && (
              <span className="text-success">+{additions}</span>
            )}
            {deletions > 0 && <span className="text-error">-{deletions}</span>}
          </span>
        )}
        {githubCommentCount > 0 && (
          <span className="inline-flex items-center gap-0.5 text-low">
            <GithubLogoIcon className="size-icon-xs" weight="fill" />
            {githubCommentCount}
          </span>
        )}
        {!IS_MOBILE && (
          <OpenInIdeButton
            onClick={handleOpenInIde}
            className="size-icon-xs p-0"
          />
        )}
      </div>
    ),
    [
      handleCopyFilePath,
      handleOpenInIde,
      githubCommentCount,
      additions,
      deletions,
    ]
  );

  const FileIcon = useMemo(
    () => getFileIcon(filePath, actualTheme),
    [filePath, actualTheme]
  );

  const renderHeaderPrefix = useCallback(
    () => (
      <span className="min-w-0 max-w-full flex flex-1 items-center gap-2 overflow-hidden">
        <FileIcon className="size-icon-base shrink-0" />
        <MiddleEllipsisPath path={filePath} className="text-xs leading-none" />
      </span>
    ),
    [FileIcon, filePath]
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ExtendedCommentAnnotation>) => {
      const { metadata } = annotation;

      if (metadata.type === 'draft') {
        return (
          <CommentWidgetLine
            draft={metadata.draft}
            widgetKey={metadata.widgetKey}
            onSave={NOOP}
            onCancel={NOOP}
          />
        );
      }

      if (metadata.type === 'github') {
        const githubComment = metadata.comment;
        return (
          <GitHubCommentRenderer
            comment={githubComment}
            theme={actualTheme}
            onCopyToUserComment={() => {
              const codeLine = getCodeLineForComment(
                diff,
                githubComment.lineNumber,
                githubComment.side
              );
              addComment({
                repoId: diff.repoId,
                filePath,
                lineNumber: githubComment.lineNumber,
                side: githubComment.side,
                text: githubComment.body,
                ...(codeLine !== undefined ? { codeLine } : {}),
              });
            }}
          />
        );
      }

      return <ReviewCommentRenderer comment={metadata.comment} />;
    },
    [diff, filePath, addComment, actualTheme]
  );

  const renderHoverUtility = useCallback(
    (
      getHoveredLine: () =>
        | { lineNumber: number; side: AnnotationSide }
        | undefined
    ) => (
      <button
        className="flex items-center justify-center size-icon-base rounded text-brand bg-brand/20 transition-transform hover:scale-110"
        onClick={() => {
          const line = getHoveredLine();
          if (!line) return;
          const { side, lineNumber } = line;
          const splitSide = mapAnnotationSideToSplitSide(side);
          const widgetKey = getReviewWidgetKey(diff, splitSide, lineNumber);
          if (draftsRef.current[widgetKey]) return;

          const codeLine = getCodeLineForComment(diff, lineNumber, splitSide);
          setDraft(widgetKey, {
            repoId: diff.repoId,
            filePath,
            side: splitSide,
            lineNumber,
            text: '',
            ...(codeLine !== undefined ? { codeLine } : {}),
          });
        }}
        title={t('comments.addReviewComment')}
      >
        <PlusIcon className="size-3.5" weight="bold" />
      </button>
    ),
    [filePath, diff, setDraft, t]
  );

  return (
    <div
      data-diff-key={getDiffKey(diff)}
      data-diff-path={filePath}
      className="rounded-sm"
    >
      <FileDiff<ExtendedCommentAnnotation>
        fileDiff={fileDiffMetadata}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={annotations ? renderAnnotation : undefined}
        renderHeaderPrefix={renderHeaderPrefix}
        renderHeaderMetadata={renderHeaderMetadata}
        renderHoverUtility={renderHoverUtility}
      />
    </div>
  );
});

interface ChangesPanelContainerProps {
  className: string;
  workspaceId: string;
}

export const ChangesPanelContainer = memo(function ChangesPanelContainer({
  className,
  workspaceId,
}: ChangesPanelContainerProps) {
  const diffs = useDiffs();
  const { registerFileRequest, selectFile, selectedFilePath, selectedRepoId } =
    useChangesView();
  const { repos } = useWorkspaceRepo(workspaceId);
  const openInEditor = useOpenInEditor(workspaceId);
  const sortedDiffs = useMemo(() => sortDiffs(diffs), [diffs]);
  const groupedDiffs = useMemo(
    () =>
      groupDiffsByRepo(
        sortedDiffs,
        repos.map((repo) => ({
          id: repo.id,
          label: repo.display_name || repo.name,
        }))
      ),
    [repos, sortedDiffs]
  );
  const showRepoHeaders = repos.length > 1 || groupedDiffs.length > 1;
  const panelRef = useRef<HTMLDivElement>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isStacked, setIsStacked] = useState(false);
  const [isFileListCollapsed, setIsFileListCollapsed] = useState(false);
  const [loadedDiffKeys, setLoadedDiffKeys] = useState<Set<string>>(
    () => new Set()
  );
  const handledRequestedPathRef = useRef<string | null>(null);
  const lineScrollRequestRef = useRef(0);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const updateLayout = () => {
      const { width, height } = panel.getBoundingClientRect();
      setIsStacked(shouldStackChangesPanel(width, height));
    };

    updateLayout();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(updateLayout);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const selectedDiff = useMemo(
    () => resolveSelectedDiff(sortedDiffs, selectedKey),
    [selectedKey, sortedDiffs]
  );

  useEffect(() => {
    if (!selectedFilePath) return;
    const requestKey = `${selectedRepoId ?? 'unknown'}:${selectedFilePath}`;
    if (
      handledRequestedPathRef.current === requestKey &&
      selectedKey !== null
    ) {
      return;
    }
    const requestedDiff = findDiffByPath(
      sortedDiffs,
      selectedFilePath,
      selectedRepoId ?? undefined
    );
    if (requestedDiff) {
      handledRequestedPathRef.current = requestKey;
      setSelectedKey(getDiffKey(requestedDiff));
    }
  }, [selectedFilePath, selectedRepoId, selectedKey, sortedDiffs]);

  useEffect(() => {
    const key = selectedDiff ? getDiffKey(selectedDiff) : null;
    if (key !== selectedKey) {
      setSelectedKey(key);
      if (selectedDiff) {
        selectFile(getDiffPath(selectedDiff), selectedDiff.repoId);
      }
    }
  }, [selectedDiff, selectedKey, selectFile]);

  const handleFileRequest = useCallback(
    (path: string, lineNumber?: number, repoId?: string | null) => {
      const requestedDiff = findDiffByPath(sortedDiffs, path, repoId);
      if (!requestedDiff) return;
      const diffKey = getDiffKey(requestedDiff);
      handledRequestedPathRef.current = diffKey;
      setSelectedKey(diffKey);

      const requestId = ++lineScrollRequestRef.current;
      if (!lineNumber || requestedDiff.contentOmitted) return;

      setLoadedDiffKeys((current) => {
        if (current.has(diffKey)) return current;
        const next = new Set(current);
        next.add(diffKey);
        return next;
      });

      let attemptsRemaining = 60;
      const scrollWhenReady = () => {
        if (lineScrollRequestRef.current !== requestId) return;
        const wrapper = document.querySelector(
          `[data-diff-key="${CSS.escape(diffKey)}"]`
        );
        if (
          wrapper instanceof HTMLElement &&
          scrollToLineInDiff(wrapper, lineNumber)
        ) {
          return;
        }
        attemptsRemaining -= 1;
        if (attemptsRemaining > 0) requestAnimationFrame(scrollWhenReady);
      };
      requestAnimationFrame(scrollWhenReady);
    },
    [sortedDiffs]
  );

  useEffect(
    () => () => {
      lineScrollRequestRef.current += 1;
    },
    []
  );

  useEffect(() => {
    registerFileRequest(handleFileRequest);
    return () => {
      registerFileRequest(null);
    };
  }, [registerFileRequest, handleFileRequest]);

  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={HIGHLIGHTER_OPTIONS}
    >
      <div
        ref={panelRef}
        className={`flex flex-col h-full min-h-0 bg-secondary ${className}`}
      >
        <CommitSelector workspaceId={workspaceId} />
        <div
          className={`flex flex-1 min-h-0 ${
            isStacked ? 'flex-col' : 'flex-row'
          }`}
        >
          <section
            className={`shrink-0 overflow-hidden bg-panel flex flex-col min-h-0 ${
              isStacked
                ? `w-full max-w-none border-b border-border ${
                    isFileListCollapsed ? 'h-9' : 'h-52'
                  }`
                : 'w-64 min-w-48 max-w-[38%] border-r border-border'
            }`}
          >
            <button
              type="button"
              disabled={!isStacked}
              aria-expanded={!isFileListCollapsed}
              onClick={() => {
                if (isStacked) {
                  setIsFileListCollapsed((collapsed) => !collapsed);
                }
              }}
              className={`h-9 w-full shrink-0 px-base flex items-center justify-between border-b border-border text-left ${
                isStacked
                  ? 'cursor-pointer hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand'
                  : 'cursor-default'
              }`}
            >
              <span className="flex min-w-0 items-center gap-half text-xs font-medium text-high">
                {isStacked &&
                  (isFileListCollapsed ? (
                    <CaretRightIcon
                      className="size-icon-xs shrink-0"
                      weight="bold"
                    />
                  ) : (
                    <CaretDownIcon
                      className="size-icon-xs shrink-0"
                      weight="bold"
                    />
                  ))}
                Changed files
              </span>
              <span className="text-xs tabular-nums text-low">
                {sortedDiffs.length}
              </span>
            </button>
            <div className="min-h-0 overflow-y-auto py-1">
              {groupedDiffs.map((group) => (
                <div key={group.repoId ?? 'unknown'}>
                  {showRepoHeaders && (
                    <div
                      className="h-7 px-base flex items-center text-[10px] font-semibold uppercase tracking-wide text-low bg-secondary/70"
                      title={group.label}
                    >
                      <span className="truncate">{group.label}</span>
                    </div>
                  )}
                  {group.diffs.map((diff) => {
                    const path = getDiffPath(diff);
                    const diffKey = getDiffKey(diff);
                    const status = {
                      added: ['A', 'text-success'],
                      deleted: ['D', 'text-error'],
                      modified: ['M', 'text-warning'],
                      renamed: ['R', 'text-brand'],
                      copied: ['C', 'text-brand'],
                      permissionChange: ['P', 'text-warning'],
                    }[diff.change];
                    const isSelected = diffKey === selectedKey;

                    return (
                      <button
                        key={diffKey}
                        type="button"
                        title={path}
                        onClick={() => {
                          selectFile(path, diff.repoId);
                        }}
                        className={`w-full h-8 px-base flex items-center gap-2 text-left transition-colors ${
                          isSelected
                            ? 'bg-brand/15 text-high'
                            : 'text-normal hover:bg-secondary'
                        }`}
                      >
                        <FileIcon className="size-icon-xs shrink-0 text-low" />
                        <MiddleEllipsisPath
                          path={path}
                          className="text-[11px] leading-none"
                        />
                        <span
                          className={`w-3 shrink-0 text-center text-[10px] font-semibold ${status[1]}`}
                        >
                          {status[0]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {sortedDiffs.length === 0 && (
                <div className="px-base py-4 text-xs text-low">
                  No changed files
                </div>
              )}
            </div>
          </section>

          <section className="flex-1 min-w-0 min-h-0 overflow-auto px-base pt-1">
            {selectedDiff?.contentOmitted && (
              <div className="h-full min-h-48 flex flex-col items-center justify-center gap-2 text-center px-6">
                <p className="text-sm font-medium text-high">
                  Diff is too large to display
                </p>
                <p className="text-xs text-low">
                  This file exceeds the inline diff size limit. Open it in your
                  editor to inspect the changes.
                </p>
                {!IS_MOBILE && (
                  <button
                    type="button"
                    className="px-base py-half rounded-sm bg-brand text-white text-sm font-medium hover:bg-brand/90"
                    onClick={() => {
                      openInEditor({
                        filePath: getDiffPath(selectedDiff),
                        repoId: selectedDiff.repoId ?? undefined,
                      });
                    }}
                  >
                    Open in editor
                  </button>
                )}
              </div>
            )}
            {selectedDiff &&
              !selectedDiff.contentOmitted &&
              shouldDeferDiffLoad(selectedDiff) &&
              !loadedDiffKeys.has(getDiffKey(selectedDiff)) && (
                <div className="h-full min-h-48 flex flex-col items-center justify-center gap-3 text-center px-6">
                  <div>
                    <p className="text-sm font-medium text-high">Large diff</p>
                    <p className="mt-1 text-xs text-low">
                      {(
                        (selectedDiff.additions ?? 0) +
                        (selectedDiff.deletions ?? 0)
                      ).toLocaleString()}{' '}
                      changed lines
                    </p>
                  </div>
                  <button
                    type="button"
                    className="px-base py-half rounded-sm bg-brand text-white text-sm font-medium hover:bg-brand/90"
                    onClick={() => {
                      const diffKey = getDiffKey(selectedDiff);
                      setLoadedDiffKeys((current) => {
                        const next = new Set(current);
                        next.add(diffKey);
                        return next;
                      });
                    }}
                  >
                    Load diff
                  </button>
                </div>
              )}
            {selectedDiff &&
              !selectedDiff.contentOmitted &&
              (!shouldDeferDiffLoad(selectedDiff) ||
                loadedDiffKeys.has(getDiffKey(selectedDiff))) && (
                <DiffFileItem
                  key={getDiffKey(selectedDiff)}
                  diff={selectedDiff}
                  workspaceId={workspaceId}
                />
              )}
          </section>
        </div>
      </div>
    </WorkerPoolContextProvider>
  );
});
