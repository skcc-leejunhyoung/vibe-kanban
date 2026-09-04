import { useContext } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';

/** File request callback implemented by ChangesPanelContainer. */
export type ChangesFileRequestCallback = (
  path: string,
  lineNumber?: number,
  repoId?: string | null
) => void;

export interface ChangesFileTarget {
  path: string;
  repoId: string | null;
}

interface ChangesViewContextValue {
  selectedFilePath: string | null;
  selectedRepoId: string | null;
  selectFile: (path: string, repoId?: string | null) => void;
  selectFileAtLine: (
    path: string,
    lineNumber?: number,
    repoId?: string | null
  ) => void;
  viewFileInChanges: (filePath: string, repoId?: string | null) => void;
  findMatchingDiffTarget: (text: string) => ChangesFileTarget | null;
  registerFileRequest: (callback: ChangesFileRequestCallback | null) => void;
}

export interface ChangesViewActionsContextValue {
  viewFileInChanges: (filePath: string, repoId?: string | null) => void;
  findMatchingDiffTarget: (text: string) => ChangesFileTarget | null;
}

const defaultValue: ChangesViewContextValue = {
  selectedFilePath: null,
  selectedRepoId: null,
  selectFile: () => {},
  selectFileAtLine: () => {},
  viewFileInChanges: () => {},
  findMatchingDiffTarget: () => null,
  registerFileRequest: () => {},
};

const defaultActionsValue: ChangesViewActionsContextValue = {
  viewFileInChanges: () => {},
  findMatchingDiffTarget: () => null,
};

export const ChangesViewContext = createHmrContext<ChangesViewContextValue>(
  'ChangesViewContext',
  defaultValue
);

export const ChangesViewActionsContext =
  createHmrContext<ChangesViewActionsContextValue>(
    'ChangesViewActionsContext',
    defaultActionsValue
  );

export function useChangesView(): ChangesViewContextValue {
  return useContext(ChangesViewContext);
}

export function useChangesViewActions(): ChangesViewActionsContextValue {
  return useContext(ChangesViewActionsContext);
}
