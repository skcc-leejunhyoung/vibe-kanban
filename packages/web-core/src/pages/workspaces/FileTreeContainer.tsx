import { useState, useMemo, useCallback, useEffect, useRef } from 'react';

import { FileTree } from '@vibe/ui/components/FileTree';
import {
  buildFileTreeByRepo,
  filterFileTree,
  findDiffByFileTreePath,
  getFileTreePath,
  getExpandedPathsForSearch,
  getAllFolderPaths,
  sortDiffs,
} from '@/shared/lib/fileTreeUtils';
import { usePersistedCollapsedPaths } from '@/shared/stores/useUiPreferencesStore';
import {
  useShowGitHubComments,
  useSetShowGitHubComments,
  useGetGitHubCommentCountForFile,
  useGetFilesWithGitHubComments,
  useGetFirstCommentLineForFile,
  useIsGitHubCommentsLoading,
  useGitHubCommentsRepoId,
} from '@/shared/stores/useWorkspaceDiffStore';
import { useChangesView } from '@/shared/hooks/useChangesView';
import { getFileIcon } from '@/shared/lib/fileTypeIcon';
import { useTheme } from '@/shared/hooks/useTheme';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { getActualTheme } from '@/shared/lib/theme';
import type { Diff } from 'shared/types';

interface FileTreeContainerProps {
  workspaceId: string;
  diffs: Diff[];
  className: string;
}

export function FileTreeContainer({
  workspaceId,
  diffs,
  className,
}: FileTreeContainerProps) {
  const { theme } = useTheme();
  const actualTheme = getActualTheme(theme);
  const { repos } = useWorkspaceRepo(workspaceId);

  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedPaths, setCollapsedPaths] =
    usePersistedCollapsedPaths(workspaceId);
  const showGitHubComments = useShowGitHubComments();
  const setShowGitHubComments = useSetShowGitHubComments();
  const getGitHubCommentCountForFile = useGetGitHubCommentCountForFile();
  const getFilesWithGitHubComments = useGetFilesWithGitHubComments();
  const getFirstCommentLineForFile = useGetFirstCommentLineForFile();
  const isGitHubCommentsLoading = useIsGitHubCommentsLoading();
  const gitHubCommentsRepoId = useGitHubCommentsRepoId();

  const { selectedFilePath, selectedRepoId, selectFile, selectFileAtLine } =
    useChangesView();
  const { nodes: fullTree, groupByRepo } = useMemo(
    () =>
      buildFileTreeByRepo(
        diffs,
        repos.map((repo) => ({
          id: repo.id,
          label: repo.display_name || repo.name,
        }))
      ),
    [diffs, repos]
  );
  const activeDiff = useMemo(
    () =>
      diffs.find(
        (diff) =>
          (diff.newPath === selectedFilePath ||
            diff.oldPath === selectedFilePath) &&
          diff.repoId === selectedRepoId
      ) ?? null,
    [diffs, selectedFilePath, selectedRepoId]
  );
  const activeFilePath = activeDiff
    ? getFileTreePath(activeDiff, groupByRepo)
    : null;
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const treeScrollCallbackRef = useCallback((el: HTMLDivElement | null) => {
    treeScrollRef.current = el;
  }, []);

  useEffect(() => {
    if (!activeFilePath || !treeScrollRef.current) return;
    const container = treeScrollRef.current;
    const selector = `[data-tree-path="${CSS.escape(activeFilePath)}"]`;
    const node = container.querySelector(selector);
    if (!(node instanceof HTMLElement)) return;

    const scrollNodeIntoView = () => {
      const cRect = container.getBoundingClientRect();
      const nRect = node.getBoundingClientRect();
      if (nRect.top < cRect.top) {
        container.scrollTop += nRect.top - cRect.top - 4;
      } else if (nRect.bottom > cRect.bottom) {
        container.scrollTop += nRect.bottom - cRect.bottom + 4;
      }
    };

    scrollNodeIntoView();
    // Retry once after rAF — content-visibility reflow may shift positions
    const rafId = requestAnimationFrame(scrollNodeIntoView);
    return () => cancelAnimationFrame(rafId);
  }, [activeFilePath]);

  // Get all folder paths for expand all functionality
  const allFolderPaths = useMemo(() => getAllFolderPaths(fullTree), [fullTree]);

  // All folders are expanded when none are in the collapsed set
  const isAllExpanded = collapsedPaths.size === 0;

  // Filter tree based on search
  const filteredTree = useMemo(
    () => filterFileTree(fullTree, searchQuery),
    [fullTree, searchQuery]
  );

  // Auto-expand folders when searching (remove from collapsed set)
  const collapsedPathsRef = useRef(collapsedPaths);
  collapsedPathsRef.current = collapsedPaths;

  useEffect(() => {
    if (searchQuery) {
      const pathsToExpand = getExpandedPathsForSearch(fullTree, searchQuery);
      const next = new Set(collapsedPathsRef.current);
      pathsToExpand.forEach((p) => next.delete(p));
      setCollapsedPaths(next);
    }
  }, [searchQuery, fullTree, setCollapsedPaths]);

  const handleToggleExpand = useCallback(
    (path: string) => {
      setCollapsedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    },
    [setCollapsedPaths]
  );

  const handleToggleExpandAll = useCallback(() => {
    if (isAllExpanded) {
      setCollapsedPaths(new Set(allFolderPaths)); // collapse all
    } else {
      setCollapsedPaths(new Set()); // expand all
    }
  }, [isAllExpanded, allFolderPaths, setCollapsedPaths]);

  const handleSelectFile = useCallback(
    (path: string) => {
      const diff = findDiffByFileTreePath(fullTree, path);

      if (diff) {
        const targetPath = diff.newPath || diff.oldPath || '';
        selectFile(targetPath, diff.repoId);
      }
    },
    [fullTree, selectFile]
  );

  // Get list of diff paths that have GitHub comments, sorted to match visual order
  const filesWithComments = useMemo(() => {
    const ghFiles = getFilesWithGitHubComments();
    // Sort diffs first to match visual order, then filter to those with comments
    return sortDiffs(diffs).filter((diff) => {
      if (diff.repoId !== gitHubCommentsRepoId) return false;
      const diffPath = diff.newPath || diff.oldPath || '';
      return ghFiles.some(
        (ghPath) => diffPath === ghPath || diffPath.endsWith('/' + ghPath)
      );
    });
  }, [getFilesWithGitHubComments, gitHubCommentsRepoId, diffs]);

  // Navigate between files with GitHub comments
  const handleNavigateComments = useCallback(
    (direction: 'prev' | 'next') => {
      if (filesWithComments.length === 0) return;

      const currentIndex = filesWithComments.findIndex(
        (diff) =>
          (diff.newPath === selectedFilePath ||
            diff.oldPath === selectedFilePath) &&
          diff.repoId === selectedRepoId
      );
      let nextIndex: number;

      if (direction === 'next') {
        nextIndex =
          currentIndex < filesWithComments.length - 1 ? currentIndex + 1 : 0;
      } else {
        nextIndex =
          currentIndex > 0 ? currentIndex - 1 : filesWithComments.length - 1;
      }

      const targetDiff = filesWithComments[nextIndex];
      const targetPath = targetDiff.newPath || targetDiff.oldPath || '';
      const lineNumber = getFirstCommentLineForFile(targetPath);

      selectFileAtLine(targetPath, lineNumber ?? undefined, targetDiff.repoId);
    },
    [
      filesWithComments,
      selectedFilePath,
      selectedRepoId,
      getFirstCommentLineForFile,
      selectFileAtLine,
    ]
  );

  const renderFileIcon = useCallback(
    (fileName: string) => {
      const FileIcon = getFileIcon(fileName, actualTheme);
      return FileIcon ? <FileIcon size={14} /> : null;
    },
    [actualTheme]
  );
  const getCommentCountForTreePath = useCallback(
    (path: string) => {
      const diff = findDiffByFileTreePath(fullTree, path);
      if (diff?.repoId !== gitHubCommentsRepoId) return 0;
      const filePath = diff?.newPath || diff?.oldPath;
      return filePath ? getGitHubCommentCountForFile(filePath) : 0;
    },
    [fullTree, gitHubCommentsRepoId, getGitHubCommentCountForFile]
  );

  return (
    <FileTree
      nodes={filteredTree}
      collapsedPaths={collapsedPaths}
      onToggleExpand={handleToggleExpand}
      selectedPath={activeFilePath}
      onSelectFile={handleSelectFile}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      renderFileIcon={renderFileIcon}
      isAllExpanded={isAllExpanded}
      onToggleExpandAll={handleToggleExpandAll}
      className={className}
      scrollContainerRef={treeScrollCallbackRef}
      showGitHubComments={showGitHubComments}
      onToggleGitHubComments={setShowGitHubComments}
      getGitHubCommentCountForFile={getCommentCountForTreePath}
      isGitHubCommentsLoading={isGitHubCommentsLoading}
      onNavigateComments={handleNavigateComments}
      hasFilesWithComments={filesWithComments.length > 0}
    />
  );
}
