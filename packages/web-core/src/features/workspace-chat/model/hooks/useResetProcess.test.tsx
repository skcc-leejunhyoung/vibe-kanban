import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { useResetProcess } from './useResetProcess';

vi.mock('@/shared/hooks/useBranchStatus', () => ({
  useBranchStatus: () => ({}),
}));
vi.mock('./useResetProcessMutation', () => ({
  useResetProcessMutation: () => ({ isPending: false }),
}));
vi.mock('@/shared/hooks/useExecutionProcessesContext', () => ({
  useExecutionProcessesContext: () => ({
    executionProcessesAll: [
      {
        id: 'v2-turn',
        run_reason: 'codingagent',
        dropped: false,
        executor_action: {
          typ: {
            type: 'CodingAgentInitialRequest',
            executor_config: { executor: BaseCodingAgent.OPENCODE_V2 },
          },
        },
      },
      {
        id: 'codex-turn',
        run_reason: 'codingagent',
        dropped: false,
        executor_action: {
          typ: {
            type: 'CodingAgentFollowUpRequest',
            executor_config: { executor: BaseCodingAgent.CODEX },
          },
        },
      },
    ],
  }),
}));

it('allows reset actions for active OpenCode v2 and Codex coding turns', () => {
  function Probe() {
    const { canResetProcess } = useResetProcess('workspace', 'session');
    return (
      <div
        data-allowed={['v2-turn', 'codex-turn']
          .filter(canResetProcess)
          .join(',')}
      />
    );
  }

  expect(renderToStaticMarkup(<Probe />)).toContain(
    'data-allowed="v2-turn,codex-turn"'
  );
});
