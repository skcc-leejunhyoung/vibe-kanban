import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  SessionChatBox,
  type ExecutionStatus,
} from '@vibe/ui/components/SessionChatBox';

// Markup contract for the composer while a follow-up POST is in flight: the
// editor must stay usable (queueing), stop must be offered, and "send now"
// must be withheld (no server process to interrupt yet). `creating` keeps the
// old locked behaviour for new-session / handoff requests.
function render(status: ExecutionStatus, queued = false, canSteer = true) {
  return renderToStaticMarkup(
    <SessionChatBox
      status={status}
      editor={{ value: 'next message', onChange: () => {} }}
      renderEditor={({ disabled }) => (
        <textarea data-editor="1" disabled={disabled} />
      )}
      actions={{
        onSend: () => {},
        onQueue: () => {},
        onSteer: () => {},
        canSteer,
        onCancelQueue: () => {},
        onStop: () => {},
        onPasteFiles: () => {},
      }}
      queuedMessages={queued ? [{ id: 'q1', message: 'queued one' }] : []}
      session={{ sessions: [], onSelectSession: () => {} }}
    />
  );
}

// First button carrying the label, with its own disabled state (the `disabled`
// attribute, not the `disabled:` utility classes a button may list).
const button = (html: string, label: string) => {
  const match = html.match(
    new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`)
  );
  if (!match) return null;
  return { disabled: / disabled=""/.test(match[0]) };
};

describe('SessionChatBox while a follow-up send is pending', () => {
  it('keeps accepted artifact responses removable without offering text edits', () => {
    const html = renderToStaticMarkup(
      <SessionChatBox
        status="running"
        editor={{ value: '', onChange: () => {} }}
        renderEditor={() => null}
        actions={{
          onSend: () => {},
          onQueue: () => {},
          onCancelQueue: () => {},
          onStop: () => {},
          onPasteFiles: () => {},
        }}
        queuedMessages={[
          { id: 'artifact', message: 'response', editable: false },
        ]}
        onEditQueued={() => {}}
        onRemoveQueued={() => {}}
        session={{ sessions: [], onSelectSession: () => {} }}
      />
    );
    expect(button(html, 'conversation.actions.edit')).toBeNull();
    expect(button(html, 'conversation.actions.removeQueued')).toEqual({
      disabled: false,
    });
  });

  it('offers stop and queue while scripts run, with send now disabled', () => {
    const html = render('running', true, false);
    expect(button(html, 'conversation.actions.stop')).toEqual({
      disabled: false,
    });
    expect(button(html, 'conversation.actions.queue')).toEqual({
      disabled: false,
    });
    expect(button(html, 'conversation.actions.sendNow')).toEqual({
      disabled: true,
    });
    expect(button(render('running'), 'conversation.actions.sendNow')).toEqual({
      disabled: false,
    });
  });

  it('queues the send-now keyboard shortcut when only a script is running', () => {
    const onQueue = vi.fn();
    const onSteer = vi.fn();
    let shortcut: (() => void) | undefined;
    renderToStaticMarkup(
      <SessionChatBox
        status="running"
        editor={{ value: 'next message', onChange: () => {} }}
        renderEditor={({ onShiftCmdEnter }) => {
          shortcut = onShiftCmdEnter;
          return null;
        }}
        actions={{
          onSend: () => {},
          onQueue,
          onSteer,
          canSteer: false,
          onCancelQueue: () => {},
          onStop: () => {},
          onPasteFiles: () => {},
        }}
        session={{ sessions: [], onSelectSession: () => {} }}
      />
    );
    expect(shortcut).toBeDefined();
    shortcut!();
    expect(onQueue).toHaveBeenCalledOnce();
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('keeps the editor enabled and offers stop + queue, not send now', () => {
    const html = render('sending');
    expect(html).toContain('<textarea data-editor="1">');
    expect(button(html, 'conversation.actions.stop')).toEqual({
      disabled: false,
    });
    expect(button(html, 'conversation.actions.queue')).toEqual({
      disabled: false,
    });
    expect(button(html, 'conversation.actions.sendNow')).toEqual({
      disabled: true,
    });
    expect(button(html, 'conversation.actions.send')).toBeNull();
  });

  it('still lists queued rows (the container withholds their "send now")', () => {
    const html = render('sending', true);
    expect(html).toContain('queued one');
    expect(
      html.match(/aria-label="conversation.actions.sendNow"/g)
    ).toHaveLength(1);
  });

  it('keeps the editor open while stopping, with nothing to send', () => {
    const html = render('stopping');
    expect(html).toContain('<textarea data-editor="1">');
    expect(button(html, 'conversation.actions.queue')).toBeNull();
    expect(button(html, 'conversation.actions.send')).toBeNull();
  });

  it('still locks the editor while a session is being created', () => {
    const html = render('creating');
    expect(html).toContain('<textarea data-editor="1" disabled="">');
    expect(button(html, 'conversation.actions.queue')).toBeNull();
  });
});
