import type { ComponentProps, KeyboardEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateChatBox } from '@vibe/ui/components/CreateChatBox';
import type { ChatBoxBase } from '@vibe/ui/components/ChatBoxBase';

let capture: ComponentProps<typeof ChatBoxBase>['onKeyDownCapture'];
vi.mock('@vibe/ui/components/ChatBoxBase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vibe/ui/components/ChatBoxBase')>()),
  ChatBoxBase: (props: ComponentProps<typeof ChatBoxBase>) => {
    capture = props.onKeyDownCapture;
    return null;
  },
}));
const send = vi.fn();

beforeEach(() => {
  send.mockClear();
  renderToStaticMarkup(
    <CreateChatBox
      editor={{ value: 'Synthetic draft', onChange: vi.fn() }}
      renderEditor={() => null}
      onSend={send}
      isSending={false}
      executor={{ selected: 'test', options: ['test'], onChange: vi.fn() }}
      onEditRepos={vi.fn()}
      repoSummaryLabel="Synthetic repository"
      repoSummaryTitle="Synthetic repository"
    />
  );
});

function press({
  inside = true,
  textField = false,
  composing = false,
  ...overrides
}: Partial<KeyboardEvent> & {
  inside?: boolean;
  textField?: boolean;
  composing?: boolean;
} = {}) {
  const nativeEvent = {
    key: 'Enter',
    metaKey: true,
    isComposing: composing,
    ...overrides,
  };
  const event = {
    ...nativeEvent,
    nativeEvent,
    target: { closest: () => (textField ? {} : null) },
    currentTarget: { contains: () => inside },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  capture?.(event as unknown as KeyboardEvent<HTMLDivElement>);
  return event;
}

describe('create chat keyboard capture', () => {
  it.each([{ metaKey: true }, { metaKey: false, ctrlKey: true }])(
    'submits once from a control inside the composer with %j',
    (modifier) => {
      expect(press(modifier).preventDefault).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { metaKey: false },
    { inside: false },
    { textField: true },
    { shiftKey: true },
    { altKey: true },
    { repeat: true },
    { defaultPrevented: true },
    { composing: true },
  ])('leaves UI navigation and editor-owned keys alone: %j', (options) => {
    expect(press(options).preventDefault).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
