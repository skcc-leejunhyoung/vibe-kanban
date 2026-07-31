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
import { useDiffs } from '@/shared/stores/useWorkspaceDiffStore';
import type { Diff } from 'shared/types';

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
  preferredRepoId?: string | null
): ChangesFileTarget | null {
  const matches = diffs.filter((diff) => {
    const path = diff.newPath || diff.oldPath || '';
    return path === text || path.endsWith('/' + text);
  });
  const match =
    matches.find((diff) => diff.repoId === preferredRepoId) ?? matches[0];
  if (!match) return null;
  return {
    path: match.newPath || match.oldPath || text,
    repoId: match.repoId,
  };
}

export function ChangesViewProvider({ children }: ChangesViewProviderProps) {
  const diffs = useDiffs();
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
      findMatchingChangesTarget(diffs, text, selectedRepoId),
    [diffs, selectedRepoId]
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
