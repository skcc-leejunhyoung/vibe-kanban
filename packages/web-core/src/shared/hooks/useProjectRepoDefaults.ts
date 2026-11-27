import { scratchApi } from '@/shared/lib/api';
import {
  ScratchType,
  type DraftWorkspaceRepo,
  type ScratchPayload,
} from 'shared/types';

const SCRATCH_TYPE = ScratchType.PROJECT_REPO_DEFAULTS;

/**
 * Read project repo defaults from scratch storage.
 * Returns null if no defaults have been saved for this project. A failed read
 * throws instead: reported as "none", the next edit would save a list built
 * from nothing over the host's real one.
 */
export async function getProjectRepoDefaults(
  projectId: string,
  hostId?: string | null
): Promise<DraftWorkspaceRepo[] | null> {
  try {
    const scratch = await scratchApi.get(SCRATCH_TYPE, projectId, hostId);
    const payload = scratch?.payload as ScratchPayload | undefined;
    if (payload?.type === 'PROJECT_REPO_DEFAULTS') {
      return payload.data.repos;
    }
    return null;
  } catch (error) {
    console.error('[useProjectRepoDefaults] Failed to read defaults:', error);
    throw error;
  }
}

/**
 * Save project repo defaults to scratch storage (upsert).
 */
export async function saveProjectRepoDefaults(
  projectId: string,
  repos: DraftWorkspaceRepo[],
  hostId?: string | null
): Promise<void> {
  await scratchApi.update(
    SCRATCH_TYPE,
    projectId,
    {
      payload: {
        type: 'PROJECT_REPO_DEFAULTS',
        data: { repos },
      },
    },
    hostId
  );
}

/**
 * Read project repo defaults and filter out repos that no longer exist.
 * Returns an empty array if no defaults are saved or all saved repos are stale.
 */
export async function getValidProjectRepoDefaults(
  projectId: string,
  availableRepoIds: Set<string>,
  hostId?: string | null
): Promise<DraftWorkspaceRepo[]> {
  const defaults = await getProjectRepoDefaults(projectId, hostId);
  if (!defaults) {
    return [];
  }
  return defaults.filter((repo) => availableRepoIds.has(repo.repo_id));
}
