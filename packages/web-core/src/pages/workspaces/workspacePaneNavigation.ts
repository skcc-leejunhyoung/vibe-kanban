import {
  sameDestination,
  type WorkspacePaneDestination,
} from '@/shared/stores/useWorkspacePanesStore';

export function shouldAdoptDocumentDestination(
  documentDestination: WorkspacePaneDestination,
  activeDestination: WorkspacePaneDestination | null,
  previousActiveDestination: WorkspacePaneDestination | null | undefined
): boolean {
  if (sameDestination(documentDestination, activeDestination)) return false;
  return (
    previousActiveDestination === undefined ||
    sameDestination(previousActiveDestination, activeDestination)
  );
}
