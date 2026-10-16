import { useMemo, useCallback, type ReactNode } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  PROJECTS_SHAPE,
  PROJECT_MUTATION,
  type Project,
} from 'shared/remote-types';
import type { OrganizationMemberWithProfile } from 'shared/types';
import { useOrganizationMembers } from '@/shared/hooks/useOrganizationMembers';
import { OrgContext, type OrgContextValue } from '@/shared/hooks/useOrgContext';

interface OrgProviderProps {
  organizationId: string;
  children: ReactNode;
}

export function OrgProvider({ organizationId, children }: OrgProviderProps) {
  const params = useMemo(
    () => ({ organization_id: organizationId }),
    [organizationId]
  );
  const enabled = Boolean(organizationId);

  // Shape subscriptions (Electric sync)
  const projectsResult = useShape(PROJECTS_SHAPE, params, {
    enabled,
    mutation: PROJECT_MUTATION,
  });

  // Members data from API
  const membersQuery = useOrganizationMembers(organizationId);

  // useQuery hands back a new tracked object every render; only its fields
  // are stable, so depend on those rather than on the result object.
  const {
    data: members,
    error: membersError,
    retry: retryMembers,
  } = membersQuery;

  // Member profiles hydrate separately; they must not block the whole board.
  const isLoading = projectsResult.isLoading;

  // First error found
  const error = projectsResult.error || membersError || null;

  // Combined retry
  const retry = useCallback(() => {
    projectsResult.retry();
    void retryMembers();
  }, [projectsResult, retryMembers]);

  // Computed Maps for O(1) lookup
  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projectsResult.data) {
      map.set(project.id, project);
    }
    return map;
  }, [projectsResult.data]);

  const membersWithProfilesById = useMemo(() => {
    const map = new Map<string, OrganizationMemberWithProfile>();
    for (const member of members ?? []) {
      map.set(member.user_id, member);
    }
    return map;
  }, [members]);

  // Lookup helpers
  const getProject = useCallback(
    (projectId: string) => projectsById.get(projectId),
    [projectsById]
  );

  const value = useMemo<OrgContextValue>(
    () => ({
      organizationId,

      // Data
      projects: projectsResult.data,

      // Loading/error
      isLoading,
      error,
      retry,

      // Project mutations
      insertProject: projectsResult.insert,
      updateProject: projectsResult.update,
      removeProject: projectsResult.remove,

      // Lookup helpers
      getProject,

      // Computed aggregations
      projectsById,
      membersWithProfilesById,
    }),
    [
      organizationId,
      projectsResult,
      isLoading,
      error,
      retry,
      getProject,
      projectsById,
      membersWithProfilesById,
    ]
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}
