export type ArtifactViewState = {
  status: string;
  message: string;
  editable: boolean;
};

export type ArtifactInputBridge = {
  channel: string;
  initial: ArtifactViewState;
};

// Serialized into the inner sandbox before any artifact code. Keep this
// function self-contained. The removed bootstrap owns the private capability;
// artifact scripts can call the API, but cannot manufacture a trusted gesture.
export function installArtifactInput(config: ArtifactInputBridge) {
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
  const disabled = new WeakMap<Element, boolean>();
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
    const banner = document.querySelector('[data-vibe-status]');
    if (banner && banner.textContent !== state.message)
      banner.textContent = state.message;
    document
      .querySelectorAll<HTMLButtonElement>(
        'form[data-vibe-form] button,input[type="submit"],[data-vibe-submit],[data-vibe-cancel]'
      )
      .forEach((button) => {
        button.disabled = !state.editable;
      });
    // A password field cannot opt itself into the ordinary input path.
    fields().forEach((element) => {
      if (!disabled.has(element)) disabled.set(element, element.disabled);
      element.disabled = !state.editable || disabled.get(element)!;
      if (
        element.type === 'password' ||
        /password|one-time-code|cc-/i.test(element.autocomplete)
      ) {
        element.disabled = true;
        element.value = '';
      }
    });
  };
  const send = (event: 'submit' | 'cancel', data?: unknown) => {
    if (!armed || used || !state.editable)
      throw new Error('Use the artifact submit or cancel button');
    used = true;
    emit(event, data);
  };
  Object.defineProperty(window, 'vibe', {
    value: Object.freeze({
      submit: (data: unknown) => send('submit', data),
      cancel: () => send('cancel'),
      getState: () => ({ ...state }),
    }),
    writable: false,
    configurable: false,
  });
  const submitForm = (form: HTMLFormElement) => {
    if (!form.reportValidity()) return;
    const data: Record<string, unknown> = Object.create(null);
    for (const [name, value] of new NativeFormData(form)) {
      if (typeof value !== 'string') continue;
      const element = form.elements.namedItem(name);
      if (element instanceof HTMLInputElement && !safe(element)) continue;
      const converted =
        element instanceof HTMLInputElement &&
        ['number', 'range'].includes(element.type) &&
        value !== ''
          ? Number(value)
          : value;
      data[name] =
        name in data
          ? [
              ...(Array.isArray(data[name])
                ? (data[name] as unknown[])
                : [data[name]]),
              converted,
            ]
          : converted;
    }
    form
      .querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"][data-vibe-boolean]'
      )
      .forEach((input) => {
        if (input.name) data[input.name] = input.checked;
      });
    send('submit', data);
  };
  const arm = (form?: HTMLFormElement | null) => {
    armed = true;
    used = false;
    // Sandboxed documents cannot perform native form navigation. Finish the
    // explicit gesture ourselves, after the artifact's own click handlers.
    later(() => {
      try {
        if (!used && state.editable && form) submitForm(form);
      } finally {
        armed = false;
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
        'button,input[type="submit"],[data-vibe-submit],[data-vibe-cancel]'
      );
      if (!button || button.disabled) return;
      const form =
        button instanceof Button
          ? buttonForm(button)
          : button instanceof Input
            ? inputForm(button)
            : null;
      const registeredForm =
        form && attribute(form, 'data-vibe-form') !== null ? form : null;
      if (attribute(button, 'data-vibe-cancel') !== null) {
        arm();
        event.preventDefault();
        send('cancel');
      } else if (
        attribute(button, 'data-vibe-submit') !== null ||
        ((attribute(button, 'type') ?? 'submit').toLowerCase() === 'submit' &&
          registeredForm)
      ) {
        event.preventDefault();
        arm(registeredForm);
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
        arm(form);
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
    render();
    dispatchEvent(new CustomEvent('vibe:state', { detail: { ...state } }));
  });
  addEventListener('DOMContentLoaded', () => {
    if (!document.querySelector('[data-vibe-status]')) {
      const banner = document.createElement('p');
      banner.setAttribute('data-vibe-status', '');
      banner.setAttribute('role', 'status');
      document.body.prepend(banner);
    }
    render();
    new MutationObserver(render).observe(document.body, {
      childList: true,
      subtree: true,
      attributeFilter: ['type', 'autocomplete'],
    });
    emit('ready');
  });
}

export function artifactInputBootstrap(config: ArtifactInputBridge) {
  return `(${installArtifactInput.toString()})(${JSON.stringify(config).replaceAll('<', '\\u003c')});`;
}
