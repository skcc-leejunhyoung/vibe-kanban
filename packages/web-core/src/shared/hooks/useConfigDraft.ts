import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cloneDeep, isEqual, merge, pick } from 'lodash';
import type { Config } from 'shared/types';

/**
 * An editable copy of one host's config for a settings form.
 *
 * The form saves only the top-level fields edited in it, on top of the host's
 * current config. Its whole draft is a copy from when editing began, so
 * writing it back would undo whatever another screen saved meanwhile. For the
 * same reason a config that changes under an open draft replaces every field
 * the user has not touched.
 *
 * The draft belongs to the config it was made from: mount one instance per
 * host (key the form by host) rather than swapping `config` underneath it.
 */
export function useConfigDraft(
  config: Config | null,
  updateAndSaveConfig: (updates: Partial<Config>) => Promise<boolean>
) {
  const [draft, setDraft] = useState(() => (config ? cloneDeep(config) : null));
  const [dirty, setDirty] = useState(false);
  const editedFieldsRef = useRef(new Set<string>());
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!config) return;
    if (!dirty) {
      editedFieldsRef.current.clear();
      setDraft(cloneDeep(config));
      return;
    }
    setDraft((prev) =>
      prev
        ? { ...cloneDeep(config), ...pick(prev, [...editedFieldsRef.current]) }
        : cloneDeep(config)
    );
  }, [config, dirty]);

  const hasUnsavedChanges = useMemo(
    () => !!draft && !!config && !isEqual(draft, config),
    [draft, config]
  );

  const updateDraft = useCallback(
    (patch: Partial<Config>) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = merge({}, prev, patch);
        const edited = editedFieldsRef.current;
        for (const field of Object.keys(patch) as (keyof Config)[]) {
          // Put back to what the host has, a field is no longer an edit: it
          // follows the host again instead of pinning a value to write back.
          if (config && isEqual(next[field], config[field])) {
            edited.delete(field);
          } else {
            edited.add(field);
          }
        }
        setDirty(edited.size > 0);
        return next;
      });
    },
    [config]
  );

  /**
   * Saves the edited fields (`normalized` replaces their values just for the
   * save). Resolves `false` when the host rejected the save — a conflict, an
   * offline host, a refused permission — and the draft is then kept as is.
   */
  const saveDraft = useCallback(
    async (normalized: Partial<Config> = {}): Promise<boolean> => {
      if (!draft) return false;
      const fields = [...editedFieldsRef.current] as (keyof Config)[];
      const saved = await updateAndSaveConfig(
        pick({ ...draft, ...normalized }, fields)
      );
      const edited = editedFieldsRef.current;
      if (!saved) {
        // Nothing was written, so these are all still edits — including a
        // field typed back to the value being saved, which looked "unedited"
        // while the save showed that value as the host's.
        for (const field of fields) edited.add(field);
        setDirty(true);
        return false;
      }
      // What was typed while the save was under way is still an edit.
      const latest = draftRef.current;
      for (const field of fields) {
        if (!latest || isEqual(latest[field], draft[field])) {
          edited.delete(field);
        }
      }
      if (edited.size === 0) setDirty(false);
      return true;
    },
    [draft, updateAndSaveConfig]
  );

  const discardDraft = useCallback(() => {
    if (!config) return;
    editedFieldsRef.current.clear();
    setDraft(cloneDeep(config));
    setDirty(false);
  }, [config]);

  return { draft, hasUnsavedChanges, updateDraft, saveDraft, discardDraft };
}
