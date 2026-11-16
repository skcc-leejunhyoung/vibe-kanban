import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';
import { DEFAULT_CONFIG } from '@/shared/lib/defaultConfig';
import { installDomlessReact } from '@/shared/lib/electric/electricTestKit';
import { useConfigDraft } from './useConfigDraft';

const base: Config = {
  ...DEFAULT_CONFIG,
  git_branch_prefix: 'base',
  host_nickname: 'Studio',
};

let dom: ReturnType<typeof installDomlessReact>;
let form: ReturnType<typeof useConfigDraft>;
let config: Config | null;
const save = vi.fn<(updates: Partial<Config>) => Promise<boolean>>();

function Probe({ current }: { current: Config | null }) {
  form = useConfigDraft(current, save);
  return null;
}
async function render(next: Config | null = config) {
  config = next;
  await dom.render(<Probe current={config} />);
}

beforeEach(async () => {
  dom = installDomlessReact();
  save.mockReset().mockResolvedValue(true);
  await render(base);
});
afterEach(async () => {
  await dom.unmount();
  vi.unstubAllGlobals();
});

describe('config draft', () => {
  it('saves only the fields edited in the form', async () => {
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    expect(form.hasUnsavedChanges).toBe(true);
    await act(async () => {
      expect(await form.saveDraft()).toBe(true);
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({ git_branch_prefix: 'mine' });
  });

  it('does not write a stale copy of fields another screen saved meanwhile', async () => {
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    // Another surface on the same host saves a different field.
    await render({ ...base, host_nickname: 'Renamed elsewhere' });
    expect(form.draft?.host_nickname).toBe('Renamed elsewhere');
    expect(form.draft?.git_branch_prefix).toBe('mine');
    await act(async () => {
      await form.saveDraft();
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({ git_branch_prefix: 'mine' });
  });

  it('reports a rejected save and keeps the edits through the refetch', async () => {
    save.mockResolvedValue(false);
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    // The controller shows the edit optimistically, then rolls back to what
    // the host really has once the save is rejected.
    await render({ ...base, git_branch_prefix: 'mine' });
    await act(async () => {
      expect(await form.saveDraft()).toBe(false);
    });
    await render({ ...base, host_nickname: 'Server truth' });
    expect(form.draft?.git_branch_prefix).toBe('mine');
    expect(form.draft?.host_nickname).toBe('Server truth');
    expect(form.hasUnsavedChanges).toBe(true);
  });

  it('follows the config again once the save went through', async () => {
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    await act(async () => {
      await form.saveDraft();
    });
    await render({ ...base, git_branch_prefix: 'mine' });
    expect(form.hasUnsavedChanges).toBe(false);
    await render({ ...base, git_branch_prefix: 'changed later' });
    expect(form.draft?.git_branch_prefix).toBe('changed later');
  });

  it('applies save-time normalisation only to edited fields', async () => {
    await act(() => form.updateDraft({ primary_color: '#ABCDEF' }));
    await act(async () => {
      await form.saveDraft({
        primary_color: '#abcdef',
        git_branch_prefix: 'never edited',
      });
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({ primary_color: '#abcdef' });
  });

  it('discards edits back to the config', async () => {
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    await act(() => form.discardDraft());
    expect(form.draft).toEqual(base);
    expect(form.hasUnsavedChanges).toBe(false);
    await act(() => form.updateDraft({ host_nickname: 'Next' }));
    await act(async () => {
      await form.saveDraft();
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({ host_nickname: 'Next' });
  });

  it('keeps what was typed while a save was under way', async () => {
    let finish!: (saved: boolean) => void;
    save.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    let saving!: Promise<boolean>;
    await act(() => {
      saving = form.saveDraft();
    });
    await act(() => form.updateDraft({ host_nickname: 'Typed meanwhile' }));
    await render({ ...base, git_branch_prefix: 'mine' });
    await act(async () => {
      finish(true);
      expect(await saving).toBe(true);
    });
    expect(form.draft?.host_nickname).toBe('Typed meanwhile');
    expect(form.hasUnsavedChanges).toBe(true);
    await act(async () => {
      await form.saveDraft();
    });
    expect(save).toHaveBeenLastCalledWith({ host_nickname: 'Typed meanwhile' });
  });

  it('keeps the same field retyped while its save was under way', async () => {
    let finish!: (saved: boolean) => void;
    save.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    let saving!: Promise<boolean>;
    await act(() => {
      saving = form.saveDraft();
    });
    await render({ ...base, git_branch_prefix: 'mine' });
    await act(() => form.updateDraft({ git_branch_prefix: 'mine-2' }));
    await act(async () => {
      finish(true);
      expect(await saving).toBe(true);
    });
    expect(form.draft?.git_branch_prefix).toBe('mine-2');
    expect(form.hasUnsavedChanges).toBe(true);
  });

  it('keeps an edit typed back to the value being saved when that save fails', async () => {
    let finish!: (saved: boolean) => void;
    save.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
    );
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    let saving!: Promise<boolean>;
    await act(() => {
      saving = form.saveDraft();
    });
    // The value is shown optimistically while the save runs…
    await render({ ...base, git_branch_prefix: 'mine' });
    // …the user changes it and types it back, which matches what is shown…
    await act(() => form.updateDraft({ git_branch_prefix: 'other' }));
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    // …and the host rejects the save, so the shown value is rolled back.
    await act(async () => {
      finish(false);
      expect(await saving).toBe(false);
    });
    await render(base);
    expect(form.draft?.git_branch_prefix).toBe('mine');
    expect(form.hasUnsavedChanges).toBe(true);
  });

  it('lets a field put back by hand follow the host again', async () => {
    await act(() => form.updateDraft({ git_branch_prefix: 'mine' }));
    await act(() => form.updateDraft({ git_branch_prefix: 'base' }));
    expect(form.hasUnsavedChanges).toBe(false);
    // Changed elsewhere afterwards: the form shows it and would not undo it.
    await render({ ...base, git_branch_prefix: 'changed elsewhere' });
    expect(form.draft?.git_branch_prefix).toBe('changed elsewhere');
    await act(() => form.updateDraft({ host_nickname: 'Next' }));
    await act(async () => {
      await form.saveDraft();
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({ host_nickname: 'Next' });
  });

  it('starts from the config once it has loaded', async () => {
    await dom.unmount();
    dom = installDomlessReact();
    await render(null);
    expect(form.draft).toBeNull();
    expect(await form.saveDraft()).toBe(false);
    await render(base);
    expect(form.draft).toEqual(base);
  });
});
