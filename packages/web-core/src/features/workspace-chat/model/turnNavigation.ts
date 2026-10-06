import type { ExecutionProcess, ExecutorActionType } from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import type { TurnNavigationItem } from '@vibe/ui/components/TurnNavigationPopup';

// The user's prompt for a coding-agent turn lives in the execution-process
// metadata (executor_action), so the turn navigator can list every turn — even
// ones whose entries haven't been paged in yet — without loading their logs.
// Returns null for non-user processes (setup/cleanup/review scripts).
//
// Only the top-level action is inspected, never the `next_action` chain: a
// sequential setup-script process chains its `next_action` to the coding agent
// (setup → … → CodingAgentInitialRequest), so walking the chain would surface
// that prompt on the setup process too and produce a phantom duplicate turn.
// A genuine coding-agent process always carries the request at the top level
// (matches the `isFirstTurn` derivation in useConversationHistory).
function getUserPromptFromProcess(process: ExecutionProcess): string | null {
  const typ: ExecutorActionType = process.executor_action.typ;
  if (typ.type === 'CodingAgentInitialRequest' && typ.handoff_from != null) {
    return typ.handoff_user_prompt ?? null;
  }
  if (
    typ.type === 'CodingAgentInitialRequest' ||
    typ.type === 'CodingAgentFollowUpRequest'
  ) {
    return typ.prompt;
  }
  return null;
}

const createdAt = (process: ExecutionProcess) =>
  new Date(process.created_at as unknown as string).getTime();

/**
 * Every turn is derived from process metadata so the navigator lists the
 * whole conversation, not just what has been paged in. Loaded turns carry
 * their real user-entry patchKey (instant jump, active highlight); the rest
 * carry a `proc:<id>` key that the handler resolves by paging history in.
 */
export function buildTurnNavigationItems(
  entries: readonly PatchTypeWithKey[],
  processes: readonly ExecutionProcess[]
): TurnNavigationItem[] {
  const ordered = [...processes].sort((a, b) => createdAt(a) - createdAt(b));
  const processById = new Map(ordered.map((process) => [process.id, process]));
  const loadedByProcess = new Map<
    string,
    { patchKey: string; content: string }
  >();
  for (const entry of entries) {
    if (
      entry.type !== 'NORMALIZED_ENTRY' ||
      entry.content.entry_type.type !== 'user_message'
    ) {
      continue;
    }
    let processId = entry.executionProcessId;
    // Once its setup-script process is loaded, the first turn's prompt is
    // emitted under that process; attribute it to the coding turn it starts
    // so that turn keeps its real patchKey. Only script processes: a review
    // turn's own prompt must not be pinned onto the follow-up after it.
    const owner = processById.get(processId);
    if (owner?.executor_action.typ.type === 'ScriptRequest') {
      const started = ordered.find(
        (process) =>
          process.id !== owner.id &&
          createdAt(process) >= createdAt(owner) &&
          getUserPromptFromProcess(process) != null
      );
      if (started) processId = started.id;
    }
    if (!loadedByProcess.has(processId)) {
      loadedByProcess.set(processId, {
        patchKey: entry.patchKey,
        content: entry.content.content,
      });
    }
  }

  const turns: TurnNavigationItem[] = [];
  for (const process of ordered) {
    const prompt = getUserPromptFromProcess(process);
    if (prompt == null) continue;
    const loaded = loadedByProcess.get(process.id);
    turns.push({
      patchKey: loaded ? loaded.patchKey : `proc:${process.id}`,
      content: loaded ? loaded.content : prompt,
      turnNumber: turns.length + 1,
    });
  }
  return turns;
}
