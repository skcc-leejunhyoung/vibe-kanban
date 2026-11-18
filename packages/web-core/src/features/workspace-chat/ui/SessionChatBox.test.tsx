import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  SessionChatBox,
  type ExecutionStatus,
} from '@vibe/ui/components/SessionChatBox';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const noop = () => {};
function render(status: ExecutionStatus, value: string) {
  return renderToStaticMarkup(
    <SessionChatBox
      status={status}
      editor={{ value, onChange: noop }}
      renderEditor={(props) => <textarea value={props.value} readOnly />}
      actions={{
        onSend: noop,
        onQueue: noop,
        onSteer: noop,
        onCancelQueue: noop,
        onStop: noop,
        onPasteFiles: noop,
      }}
      session={{ sessions: [], onSelectSession: noop }}
    />
  );
}

describe('session running border', () => {
  it.each(['running', 'sending', 'creating'] as const)(
    'keeps the border lit while %s, with or without a queue/steer draft',
    (status) => {
      for (const draft of ['', 'Synthetic follow-up draft']) {
        expect(render(status, draft)).toContain('chat-box-running');
      }
    }
  );
  it.each(['idle', 'stopping', 'feedback', 'edit'] as const)(
    'does not light the border while %s',
    (status) => {
      expect(render(status, 'Synthetic draft')).not.toContain(
        'chat-box-running'
      );
    }
  );
});
