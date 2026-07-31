import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  useUiPreferencesStore,
  RIGHT_MAIN_PANEL_MODES,
} from '@/shared/stores/useUiPreferencesStore';
import {
  ChangesViewContext,
  ChangesViewActionsContext,
  type ChangesFileRequestCallback,
  type ChangesFileTarget,
} from '@/shared/hooks/useChangesView';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useDiffs } from '@/shared/stores/useWorkspaceDiffStore';
import type { Diff, RepoWithTargetBranch } from 'shared/types';

interface ChangesViewProviderProps {
  children: React.ReactNode;
}

export function notifyChangesFileSelection(
  callback: ChangesFileRequestCallback | null,
  path: string,
  lineNumber?: number,
  repoId?: string | null
) {
  callback?.(path, lineNumber, repoId);
}

export function findMatchingChangesTarget(
  diffs: Diff[],
  text: string,
  repos: Pick<RepoWithTargetBranch, 'id' | 'name'>[] = [],
  workingDirectory?: string | null
): ChangesFileTarget | null {
  const normalizedText = text.replace(/\\/g, '/').replace(/^\.?\//, '');
  const normalizedWorkingDirectory = workingDirectory
    ?.replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/$/, '');
  const possibleTexts = [
    normalizedText,
    ...(normalizedWorkingDirectory
      ? [`${normalizedWorkingDirectory}/${normalizedText}`]
      : []),
  ];
  const matches = diffs.flatMap((diff) => {
    const path = diff.newPath || diff.oldPath || '';
    if (!path) return [];
    const repoName = repos.find((repo) => repo.id === diff.repoId)?.name;
    const repoPath = repoName ? `${repoName}/${path}` : null;
    const explicitlyQualified =
      repoPath !== null &&
      possibleTexts.some(
        (candidate) =>
          candidate === repoPath || candidate.endsWith(`/${repoPath}`)
      );
    const pathMatches =
      path === normalizedText || normalizedText.endsWith(`/${path}`);
    return pathMatches
      ? [{ diff, explicitlyQualified, exactPath: path === normalizedText }]
      : [];
  });

  const explicitlyQualifiedMatches = matches.filter(
    ({ explicitlyQualified }) => explicitlyQualified
  );
  const exactPathMatches = matches.filter(({ exactPath }) => exactPath);
  const candidates =
    explicitlyQualifiedMatches.length > 0
      ? explicitlyQualifiedMatches
      : exactPathMatches.length > 0
        ? exactPathMatches
        : matches;
  const match = candidates.length === 1 ? candidates[0].diff : null;
  if (!match) return null;
  return {
    path: match.newPath || match.oldPath || text,
    repoId: match.repoId,
  };
}

export function ChangesViewProvider({ children }: ChangesViewProviderProps) {
  const diffs = useDiffs();
  const { repos, selectedSession } = useWorkspaceContext();
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const setRightMainPanelMode = useUiPreferencesStore(
    (s) => s.setRightMainPanelMode
  );

  const fileRequestCallbackRef = useRef<ChangesFileRequestCallback | null>(
    null
  );
  const registerFileRequest = useCallback(
    (callback: ChangesFileRequestCallback | null) => {
      fileRequestCallbackRef.current = callback;
    },
    []
  );

  const selectFile = useCallback((path: string, repoId?: string | null) => {
    setSelectedFilePath(path);
    setSelectedRepoId(repoId ?? null);
    notifyChangesFileSelection(
      fileRequestCallbackRef.current,
      path,
      undefined,
      repoId
    );
  }, []);

  const selectFileAtLine = useCallback(
    (path: string, lineNumber?: number, repoId?: string | null) => {
      setSelectedFilePath(path);
      setSelectedRepoId(repoId ?? null);
      notifyChangesFileSelection(
        fileRequestCallbackRef.current,
        path,
        lineNumber,
        repoId
      );
    },
    []
  );

  const viewFileInChanges = useCallback(
    (filePath: string, repoId?: string | null) => {
      setRightMainPanelMode(RIGHT_MAIN_PANEL_MODES.CHANGES);
      setSelectedFilePath(filePath);
      setSelectedRepoId(repoId ?? null);
      notifyChangesFileSelection(
        fileRequestCallbackRef.current,
        filePath,
        undefined,
        repoId
      );
    },
    [setRightMainPanelMode]
  );

  const findMatchingDiffTarget = useCallback(
    (text: string): ChangesFileTarget | null =>
      findMatchingChangesTarget(
        diffs,
        text,
        repos,
        selectedSession?.agent_working_dir
      ),
    [diffs, repos, selectedSession?.agent_working_dir]
  );

  const actionsValue = useMemo(
    () => ({ viewFileInChanges, findMatchingDiffTarget }),
    [viewFileInChanges, findMatchingDiffTarget]
  );

  const value = useMemo(
    () => ({
      selectedFilePath,
      selectedRepoId,
      selectFile,
      selectFileAtLine,
      viewFileInChanges,
      findMatchingDiffTarget,
      registerFileRequest,
    }),
    [
      selectedFilePath,
      selectedRepoId,
      selectFile,
      selectFileAtLine,
      viewFileInChanges,
      findMatchingDiffTarget,
      registerFileRequest,
    ]
  );

  return (
    <ChangesViewActionsContext.Provider value={actionsValue}>
      <ChangesViewContext.Provider value={value}>
        {children}
      </ChangesViewContext.Provider>
    </ChangesViewActionsContext.Provider>
  );
}
