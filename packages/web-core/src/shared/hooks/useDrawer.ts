import { useMemo } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  DRAWER_COMMENTS_SHAPE,
  DRAWER_COMMENT_MUTATION,
  DRAWER_NOTES_SHAPE,
  DRAWER_NOTE_MUTATION,
} from 'shared/remote-types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import { splitDrawerNotes } from '@/shared/lib/drawer';

/**
 * The user's Drawer (notes the Autopilot writes, synced through Electric).
 * `enabled` is false when signed out — the tab then explains why it is empty.
 */
export function useDrawerNotes(options: { enabled?: boolean } = {}) {
  const { isSignedIn, userId } = useAuth();
  const enabled = (options.enabled ?? true) && isSignedIn && !!userId;
  const result = useShape(
    DRAWER_NOTES_SHAPE,
    { user_id: userId || '' },
    { enabled, mutation: DRAWER_NOTE_MUTATION }
  );
  const split = useMemo(() => splitDrawerNotes(result.data), [result.data]);
  return { ...result, enabled, ...split };
}

/** Comments on every note (one owner-scoped shape); filter by note id. */
export function useDrawerComments(options: { enabled?: boolean } = {}) {
  const { isSignedIn, userId } = useAuth();
  const enabled = (options.enabled ?? true) && isSignedIn && !!userId;
  return useShape(
    DRAWER_COMMENTS_SHAPE,
    { user_id: userId || '' },
    { enabled, mutation: DRAWER_COMMENT_MUTATION }
  );
}
