import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from 'shared/types';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import {
  useQuickChatHostDraft,
  type QuickChatHostDraft,
  type QuickChatHostDraftPatch,
} from './useQuickChatHostDraft';

const repo = (name: string) => ({ id: name, name }) as unknown as Repo;

let dom: ReturnType<typeof installDomlessReact>;
let draft: QuickChatHostDraft;
let update: (forHostKey: string | null, patch: QuickChatHostDraftPatch) => void;

function Probe({ hostKey }: { hostKey: string | null }) {
  [draft, update] = useQuickChatHostDraft(hostKey);
  return null;
}
const select = (hostKey: string | null) =>
  dom.render(<Probe hostKey={hostKey} />);

beforeEach(() => {
  dom = installDomlessReact();
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

describe('quick chat host draft', () => {
  it('keeps the folder and model for as long as the host stays selected', async () => {
    await select('host-b');
    await act(() => update('host-b', { repo: repo('picked') }));
    await act(() =>
      update('host-b', () => ({
        scratchConfig: {
          executor: 'CODEX',
        } as QuickChatHostDraft['scratchConfig'],
      }))
    );
    // The dialog closing and reopening re-renders with the same host.
    await select('host-b');
    expect(draft.repo?.name).toBe('picked');
    expect(draft.scratchConfig?.executor).toBe('CODEX');
  });

  it('leaves the draft behind when another host is selected, for good', async () => {
    await select('host-b');
    await act(() => update('host-b', { repo: repo('on-b') }));
    await select(null);
    expect(draft.repo).toBeNull();
    await select('host-b');
    expect(draft.repo).toBeNull();
  });

  it('ignores an answer that arrives for a host no longer selected', async () => {
    await select('host-b');
    const lateAnswerForB = () => update('host-b', { repo: repo('on-b') });
    await select('this-machine');
    await act(lateAnswerForB);
    expect(draft.repo).toBeNull();
  });
});
