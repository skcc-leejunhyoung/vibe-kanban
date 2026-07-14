import type { ExecutionProcess } from 'shared/types';

export const belongsToSession = (
  process: ExecutionProcess,
  sessionId: string | undefined
): boolean => !!sessionId && process.session_id === sessionId;
