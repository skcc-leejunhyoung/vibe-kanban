export type ArtifactViewState = {
  status: string;
  message: string;
  editable: boolean;
  data?: unknown;
  revision?: number;
  updatedAt?: string | null;
  request?: unknown;
};

export type ArtifactInputBridge = {
  channel: string;
  initial: ArtifactViewState;
  arrayFields?: string[];
  requestId?: string;
  version?: string;
  actions?: string[];
};

export function collectArtifactFormValues(
  entries: Iterable<readonly [string, unknown]>,
  arrayFields: string[] = []
) {
  const data: Record<string, unknown> = Object.create(null);
  for (const name of arrayFields) data[name] = [];
  for (const [name, value] of entries) {
    if (!(name in data)) data[name] = value;
    else if (Array.isArray(data[name])) (data[name] as unknown[]).push(value);
    else data[name] = [data[name], value];
  }
  return data;
}

// Serialized into the inner sandbox before any artifact code. Keep this
// function self-contained. The removed bootstrap owns the private capability;
// artifact scripts can call the API, but cannot manufacture a trusted gesture.
export function installArtifactInput(
  config: ArtifactInputBridge,
  collectValues = collectArtifactFormValues
) {
  document.currentScript?.remove();
  const post = parent.postMessage.bind(parent);
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const later = setTimeout.bind(window);
  const NativeFormData = FormData;
  const Input = HTMLInputElement;
  const Button = HTMLButtonElement;
  const targetOf = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(Event.prototype, 'target')!.get!
  );
  const keyOf = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, 'key')!.get!
  );
  const closest = Function.prototype.call.bind(Element.prototype.closest);
  const attribute = Function.prototype.call.bind(
    Element.prototype.getAttribute
  );
  const buttonForm = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'form')!.get!
  );
  const inputForm = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'form')!.get!
  );
  const formElements = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements')!.get!
  );
  const reportValidity = Function.prototype.call.bind(
    HTMLFormElement.prototype.reportValidity
  );
  const emit = (event: string, data?: unknown) => {
    const serialized = stringify(data ?? null);
    if (serialized.length > 32768) throw new Error('Input is too large');
    post(
      {
        type: 'vibe:artifact:input',
        channel: config.channel,
        event,
        data: parse(serialized),
      },
      '*'
    );
  };
  let state = config.initial;
  let armed = false;
  let used = false;
  let composing = false;
  let composingEnter = false;
  let armedAction: string | undefined;
  const disabled = new WeakMap<Element, boolean>();
  let observer: MutationObserver | undefined;
  const rememberDisabled = (records: MutationRecord[]) => {
    for (const record of records) {
      if (
        record.attributeName === 'disabled' &&
        disabled.has(record.target as Element)
      ) {
        const element = record.target as Element & { disabled: boolean };
        disabled.set(element, element.disabled);
      }
    }
  };
  const setDisabled = (
    element: Element & { disabled: boolean },
    value: boolean
  ) => {
    if (element.disabled === value) return;
    element.disabled = value;
    // Host writes must not replace the artifact's own validation state.
    observer?.takeRecords();
  };
  const updateDisabled = (element: Element & { disabled: boolean }) => {
    if (!state.editable) {
      if (!disabled.has(element)) disabled.set(element, element.disabled);
      setDisabled(element, true);
    } else if (disabled.has(element)) {
      setDisabled(element, disabled.get(element)!);
      disabled.delete(element);
    }
  };
  const fields = () =>
    Array.from(
      document.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >('input,textarea,select')
    );
  const safe = (
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  ) =>
    !['password', 'file', 'hidden'].includes(element.type) &&
    !/password|one-time-code|cc-/i.test(element.autocomplete);
  const draft = () =>
    fields()
      .filter(safe)
      .map((element, index) => ({
        index,
        name: element.name,
        value: element.value,
        checked:
          element instanceof HTMLInputElement ? element.checked : undefined,
        selected:
          element instanceof HTMLSelectElement && element.multiple
            ? Array.from(element.selectedOptions, (o) => o.value)
            : undefined,
      }));
  const render = () => {
    rememberDisabled(observer?.takeRecords() ?? []);
    const banner = document.querySelector('[data-vibe-status]');
    if (banner && banner.textContent !== state.message)
      banner.textContent = state.message;
    document
      .querySelectorAll<HTMLButtonElement>(
        'form[data-vibe-form] button,input[type="submit"],[data-vibe-submit],[data-vibe-cancel],[data-vibe-request]'
      )
      .forEach(updateDisabled);
    // A password field cannot opt itself into the ordinary input path.
    fields().forEach((element) => {
      updateDisabled(element);
      if (
        element.type === 'password' ||
        /password|one-time-code|cc-/i.test(element.autocomplete)
      ) {
        setDisabled(element, true);
        element.value = '';
      }
    });
  };
  const send = (event: 'submit' | 'cancel' | 'request', data?: unknown) => {
    if (!armed || used || !state.editable)
      throw new Error('Use the artifact submit or cancel button');
    used = true;
    emit(event, data);
  };
  const request = (action: string, data: unknown = {}) => {
    if (!config.actions?.includes(action) || armedAction !== action)
      throw new Error('Use the registered automation action button');
    send('request', { action, data });
  };
  Object.defineProperty(window, 'vibe', {
    value: Object.freeze({
      submit: (data: unknown) => send('submit', data),
      cancel: () => send('cancel'),
      getState: () => ({ ...state }),
      getData: () =>
        parse(
          stringify({
            data: state.data ?? null,
            revision: state.revision ?? 0,
            updatedAt: state.updatedAt ?? null,
          })
        ),
      request,
    }),
    writable: false,
    configurable: false,
  });
  const submitForm = (
    form: HTMLFormElement,
    submitter?: HTMLButtonElement | HTMLInputElement
  ) => {
    if (!reportValidity(form)) return;
    const controls = new Map<string, Element[]>();
    for (const element of formElements(form) as HTMLFormControlsCollection) {
      if (
        !(
          element instanceof Input ||
          element instanceof Button ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) ||
        !element.name ||
        element.matches(':disabled') ||
        (['submit', 'image', 'button', 'reset'].includes(element.type) &&
          element !== submitter) ||
        (element instanceof Input &&
          ['checkbox', 'radio'].includes(element.type) &&
          !element.checked)
      )
        continue;
      const values =
        element instanceof HTMLSelectElement
          ? Array.from(element.selectedOptions).filter(
              (option) => !option.matches(':disabled')
            )
          : [element];
      const named = controls.get(element.name) ?? [];
      named.push(...values.map(() => element));
      controls.set(element.name, named);
    }
    const entries: [string, unknown][] = [];
    for (const [name, value] of new NativeFormData(form, submitter)) {
      const element = controls.get(name)?.shift();
      if (typeof value !== 'string') continue;
      if (element instanceof HTMLInputElement && !safe(element)) continue;
      const converted =
        element instanceof HTMLInputElement &&
        ['number', 'range'].includes(element.type) &&
        value !== ''
          ? Number(value)
          : value;
      entries.push([name, converted]);
    }
    const data = collectValues(entries, config.arrayFields);
    for (const input of formElements(form) as HTMLFormControlsCollection) {
      if (
        input instanceof Input &&
        input.type === 'checkbox' &&
        input.hasAttribute('data-vibe-boolean') &&
        input.name &&
        !input.matches(':disabled')
      )
        data[input.name] = input.checked;
    }
    send('submit', data);
  };
  const arm = (
    form?: HTMLFormElement | null,
    submitter?: HTMLButtonElement | HTMLInputElement,
    action?: string
  ) => {
    armed = true;
    used = false;
    armedAction = action;
    // Sandboxed documents cannot perform native form navigation. Finish the
    // explicit gesture ourselves, after the artifact's own click handlers.
    later(() => {
      try {
        if (!used && state.editable && action) request(action);
        else if (!used && state.editable && form) submitForm(form, submitter);
      } finally {
        armed = false;
        armedAction = undefined;
      }
    }, 0);
  };
  addEventListener(
    'compositionstart',
    () => {
      composing = true;
    },
    true
  );
  addEventListener(
    'compositionend',
    () => {
      composing = false;
    },
    true
  );
  addEventListener(
    'click',
    (event) => {
      if (event.detail === 0 && (composing || composingEnter)) {
        event.preventDefault();
        return;
      }
      if (
        !event.isTrusted ||
        !state.editable ||
        !(targetOf(event) instanceof Element)
      )
        return;
      const button = closest(
        targetOf(event),
        'button,input[type="submit"],[data-vibe-submit],[data-vibe-cancel],[data-vibe-request]'
      );
      if (!button || button.matches(':disabled')) return;
      const form =
        button instanceof Button
          ? buttonForm(button)
          : button instanceof Input
            ? inputForm(button)
            : null;
      const registeredForm =
        form && attribute(form, 'data-vibe-form') !== null ? form : null;
      const action = attribute(button, 'data-vibe-request');
      if (action !== null) {
        event.preventDefault();
        if (config.actions?.includes(action)) arm(null, undefined, action);
      } else if (attribute(button, 'data-vibe-cancel') !== null) {
        arm();
        event.preventDefault();
        send('cancel');
      } else if (
        attribute(button, 'data-vibe-submit') !== null ||
        ((attribute(button, 'type') ?? 'submit').toLowerCase() === 'submit' &&
          registeredForm)
      ) {
        event.preventDefault();
        arm(registeredForm, button.type === 'submit' ? button : undefined);
      }
    },
    true
  );
  addEventListener(
    'keydown',
    (event) => {
      if (
        event.isTrusted &&
        keyOf(event) === 'Enter' &&
        (composing || event.isComposing)
      ) {
        composingEnter = true;
        later(() => {
          composingEnter = false;
        }, 0);
        return;
      }
      if (
        !event.isTrusted ||
        keyOf(event) !== 'Enter' ||
        event.isComposing ||
        composing ||
        !state.editable
      )
        return;
      const target = targetOf(event);
      const form = target instanceof Input ? inputForm(target) : null;
      if (form && attribute(form, 'data-vibe-form') !== null) {
        event.preventDefault();
        const submitter =
          target.type === 'submit'
            ? target
            : Array.from(formElements(form) as HTMLFormControlsCollection).find(
                (element): element is HTMLButtonElement | HTMLInputElement =>
                  (element instanceof Button || element instanceof Input) &&
                  element.type === 'submit'
              );
        if (submitter?.matches(':disabled')) return;
        const action = submitter
          ? attribute(submitter, 'data-vibe-request')
          : null;
        if (action !== null) {
          if (config.actions?.includes(action)) arm(null, undefined, action);
        } else if (
          submitter &&
          attribute(submitter, 'data-vibe-cancel') !== null
        ) {
          arm();
          send('cancel');
        } else arm(form, submitter);
      }
    },
    true
  );
  addEventListener('submit', (event) => event.preventDefault(), true);
  const changed = () => {
    if (state.editable) emit('draft', draft());
  };
  addEventListener('input', changed);
  addEventListener('change', changed);
  addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.type !== 'vibe:artifact:state')
      return;
    state = event.data.value;
    render();
    if (Array.isArray(event.data.draft)) {
      const elements = fields().filter(safe);
      for (const saved of event.data.draft) {
        const element = elements[saved.index];
        if (
          !element ||
          element.name !== saved.name ||
          typeof saved.value !== 'string'
        )
          continue;
        element.value = saved.value;
        if (
          element instanceof HTMLInputElement &&
          typeof saved.checked === 'boolean'
        )
          element.checked = saved.checked;
        if (
          element instanceof HTMLSelectElement &&
          Array.isArray(saved.selected)
        )
          Array.from(element.options).forEach((o) => {
            o.selected = saved.selected.includes(o.value);
          });
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    dispatchEvent(new CustomEvent('vibe:state', { detail: { ...state } }));
    if (config.actions)
      dispatchEvent(
        new CustomEvent('vibe:data', {
          detail: {
            data: state.data ?? null,
            revision: state.revision ?? 0,
            updatedAt: state.updatedAt ?? null,
          },
        })
      );
  });
  addEventListener('DOMContentLoaded', () => {
    if (!document.querySelector('[data-vibe-status]')) {
      const banner = document.createElement('p');
      banner.setAttribute('data-vibe-status', '');
      banner.setAttribute('role', 'status');
      document.body.prepend(banner);
    }
    render();
    observer = new MutationObserver((records) => {
      rememberDisabled(records);
      render();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributeFilter: ['type', 'autocomplete', 'disabled'],
    });
    emit('ready');
  });
}

export function artifactInputBootstrap(config: ArtifactInputBridge) {
  return `(${installArtifactInput.toString()})(${JSON.stringify(config).replaceAll('<', '\\u003c')}, ${collectArtifactFormValues.toString()});`;
}
