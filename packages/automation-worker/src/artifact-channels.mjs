import { createHash, randomUUID } from "node:crypto";

const MAX_BYTES = 32768;
const own = (object, key) => Object.hasOwn(object, key);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
const name = (value) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_-]{1,80}$/.test(value) &&
  !["__proto__", "constructor", "prototype"].includes(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const scopeKeys = ["owner_id", "owner_host", "workspace_id", "session_id"];
const unresolved = (record) =>
  ["processing", "accepted", "unknown"].includes(record.status);

// The same closed, bounded schema subset as artifact input; no secret fields.
export function validateArtifactSchema(
  schema,
  value,
  depth = 0,
  checkOnly = false,
) {
  if (!schema || depth > 8) fail("Invalid artifact schema");
  const allowed = {
    object: ["type", "properties", "required"],
    string: ["type", "enum", "maxLength"],
    number: ["type", "minimum", "maximum"],
    boolean: ["type"],
    array: ["type", "items", "maxItems"],
  }[schema.type];
  if (!allowed || Object.keys(schema).some((key) => !allowed.includes(key)))
    fail("Unsupported artifact schema");
  switch (schema.type) {
    case "object": {
      const fields = schema.properties;
      if (
        !fields ||
        Array.isArray(fields) ||
        typeof fields !== "object" ||
        Object.keys(fields).length > 64
      )
        fail("Invalid object schema");
      const required = schema.required ?? [];
      if (!Array.isArray(required) || required.some((key) => !own(fields, key)))
        fail("Invalid required fields");
      if (
        !checkOnly &&
        (!value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).some((key) => !own(fields, key)) ||
          required.some((key) => !own(value, key)))
      )
        fail("Input does not match registered fields");
      for (const [key, field] of Object.entries(fields)) {
        if (
          !key ||
          Buffer.byteLength(key) > 80 ||
          ["__proto__", "constructor", "prototype"].includes(key) ||
          /^(password|passwd|secret|credential|access_token|api_key)$/i.test(
            key,
          )
        )
          fail("Invalid or sensitive field");
        validateArtifactSchema(
          field,
          value?.[key],
          depth + 1,
          checkOnly || !own(value ?? {}, key),
        );
      }
      break;
    }
    case "string": {
      const max = schema.maxLength ?? 4000;
      if (!Number.isInteger(max) || max < 0 || max > 16000)
        fail("Invalid string limit");
      if (
        schema.enum &&
        (!Array.isArray(schema.enum) ||
          !schema.enum.length ||
          schema.enum.length > 100 ||
          schema.enum.some(
            (item) => typeof item !== "string" || [...item].length > max,
          ))
      )
        fail("Invalid choices");
      if (
        !checkOnly &&
        (typeof value !== "string" ||
          [...value].length > max ||
          (schema.enum && !schema.enum.includes(value)))
      )
        fail("Invalid string value");
      break;
    }
    case "number":
      if (
        ["minimum", "maximum"].some(
          (key) => schema[key] != null && !Number.isFinite(schema[key]),
        ) ||
        (schema.minimum != null &&
          schema.maximum != null &&
          schema.minimum > schema.maximum)
      )
        fail("Invalid numeric bounds");
      if (
        !checkOnly &&
        (!Number.isFinite(value) ||
          (schema.minimum != null && value < schema.minimum) ||
          (schema.maximum != null && value > schema.maximum))
      )
        fail("Invalid number value");
      break;
    case "boolean":
      if (!checkOnly && typeof value !== "boolean")
        fail("Invalid boolean value");
      break;
    case "array": {
      const max = schema.maxItems ?? 100;
      if (!Number.isInteger(max) || max < 0 || max > 200)
        fail("Invalid array limit");
      validateArtifactSchema(schema.items, undefined, depth + 1, true);
      if (!checkOnly) {
        if (!Array.isArray(value) || value.length > max)
          fail("Invalid array value");
        for (const item of value)
          validateArtifactSchema(schema.items, item, depth + 1);
      }
    }
  }
  if (
    !checkOnly &&
    depth === 0 &&
    Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES
  )
    fail("Artifact data too large", 413);
}

export function createArtifactChannels({ state, persist, runRule }) {
  state.artifactChannels ||= {};
  state.artifactRequests ||= {};
  // An interrupted action is never automatically dispatched again.
  for (const record of Object.values(state.artifactRequests)) {
    if (record.status === "processing") record.status = "unknown";
  }
  // Reads wait for persistence and rollback before exposing a changed state.
  let writes = Promise.resolve();
  const locked = (callback) => {
    const pending = writes.then(callback);
    writes = pending.catch(() => {});
    return pending;
  };
  const ruleFor = (id) => {
    const rule = state.rules.find((item) => item.id === id);
    if (!rule?.enabled || (rule.kind && rule.kind !== "script"))
      fail("Enabled script rule required", 409);
    return rule;
  };
  const channelFor = (id) => {
    if (!name(id) || !own(state.artifactChannels, id))
      fail("Unknown artifact channel", 404);
    const channel = state.artifactChannels[id];
    if (!state.enabled || !channel.enabled)
      fail("Artifact channel is disabled", 409);
    return channel;
  };
  const describe = (channel) => {
    const actions = Object.fromEntries(
      Object.entries(channel.actions).map(([key, action]) => {
        ruleFor(action.rule_id);
        return [key, { label: action.label, schema: action.schema }];
      }),
    );
    return {
      channel_id: channel.id,
      version: hash([
        channel.generation,
        channel.scope,
        channel.data_schema,
        channel.publishers,
        channel.actions,
        Object.values(channel.actions).map((action) => ruleFor(action.rule_id)),
      ]),
      data_schema: channel.data_schema,
      actions,
    };
  };
  const scoped = (id, scope, version) => {
    const channel = channelFor(id);
    if (!scope || scopeKeys.some((key) => channel.scope[key] !== scope[key]))
      fail("Wrong artifact channel scope", 403);
    const binding = describe(channel);
    if (version && version !== binding.version)
      fail("Artifact channel changed; register a new request", 409);
    return { channel, binding };
  };
  const publicRecord = (record) =>
    record
      ? {
          request_id: record.request_id,
          action: record.action,
          status: record.status,
          message: record.message ?? null,
        }
      : null;
  return {
    describe(id, scope) {
      return locked(() => structuredClone(scoped(id, scope).binding));
    },
    async configure(input) {
      return locked(async () => {
        if (
          !name(input.id) ||
          input.sensitive !== false ||
          !input.scope ||
          scopeKeys.some(
            (key) =>
              typeof input.scope[key] !== "string" ||
              !input.scope[key] ||
              input.scope[key].length > 200,
          )
        )
          fail("Explicit non-sensitive channel and scope required");
        if (
          !input.actions ||
          typeof input.actions !== "object" ||
          Array.isArray(input.actions) ||
          Object.keys(input.actions).length > 16
        )
          fail("At most 16 actions allowed");
        validateArtifactSchema(input.data_schema, undefined, 0, true);
        const actions = {};
        for (const [key, action] of Object.entries(input.actions)) {
          if (
            !name(key) ||
            !action ||
            typeof action.label !== "string" ||
            !action.label.trim() ||
            action.label.length > 120
          )
            fail("Invalid action");
          ruleFor(action.rule_id);
          if (action.schema?.type !== "object")
            fail("Action schema must be an object");
          validateArtifactSchema(action.schema, undefined, 0, true);
          actions[key] = {
            rule_id: action.rule_id,
            label: action.label,
            schema: action.schema,
          };
        }
        if (!Array.isArray(input.publishers) || input.publishers.length > 16)
          fail("Publisher rule list required");
        for (const id of input.publishers) ruleFor(id);
        if (
          !own(state.artifactChannels, input.id) &&
          Object.keys(state.artifactChannels).length >= 128
        )
          fail("Too many artifact channels");
        const previous = state.artifactChannels[input.id];
        if (
          previous &&
          scopeKeys.some((key) => previous.scope[key] !== input.scope[key])
        )
          fail("Channel scope is immutable; use a new channel ID", 409);
        const channel = {
          id: input.id,
          generation: previous?.generation ?? randomUUID(),
          scope: Object.fromEntries(
            scopeKeys.map((key) => [key, input.scope[key]]),
          ),
          enabled: input.enabled === true,
          data_schema: input.data_schema,
          actions,
          publishers: input.publishers,
          revision: 0,
          updated_at: null,
          data: null,
        };
        state.artifactChannels[input.id] = channel;
        try {
          await persist();
        } catch (error) {
          if (previous) state.artifactChannels[input.id] = previous;
          else delete state.artifactChannels[input.id];
          throw error;
        }
        return { channel_id: channel.id };
      });
    },
    async remove(id) {
      return locked(async () => {
        if (!name(id) || !own(state.artifactChannels, id))
          fail("Unknown artifact channel", 404);
        if (
          Object.values(state.artifactRequests).some(
            (record) => record.channel_id === id && unresolved(record),
          )
        )
          fail(
            "Resolve unfinished artifact requests before deleting the channel",
            409,
          );
        const channel = state.artifactChannels[id];
        delete state.artifactChannels[id];
        try {
          await persist();
        } catch (error) {
          state.artifactChannels[id] = channel;
          throw error;
        }
        return { channel_id: id };
      });
    },
    snapshot(id, scope, version, bindingId, requestId) {
      return locked(() => {
        const { channel } = scoped(id, scope, version);
        const record = requestId
          ? state.artifactRequests[requestId]
          : Object.values(state.artifactRequests).findLast(
              (item) => item.channel_id === id && item.binding_id === bindingId,
            );
        if (
          record &&
          (record.channel_id !== id || record.binding_id !== bindingId)
        )
          fail("Wrong request scope", 403);
        return structuredClone({
          revision: channel.revision,
          updated_at: channel.updated_at,
          data: channel.data,
          request: publicRecord(record),
        });
      });
    },
    async publish(ruleId, id, data) {
      return locked(async () => {
        const channel = channelFor(id);
        if (!channel.publishers.includes(ruleId))
          fail("Rule is not a registered publisher", 403);
        validateArtifactSchema(channel.data_schema, data);
        const previous = {
          data: channel.data,
          revision: channel.revision,
          updated_at: channel.updated_at,
        };
        Object.assign(channel, {
          data: structuredClone(data),
          revision: channel.revision + 1,
          updated_at: new Date().toISOString(),
        });
        try {
          await persist();
        } catch (error) {
          Object.assign(channel, previous);
          throw error;
        }
      });
    },
    async complete(ruleId, id, requestId, status, message = null) {
      return locked(async () => {
        const channel = channelFor(id);
        if (!channel.publishers.includes(ruleId))
          fail("Rule is not a registered publisher", 403);
        const record = state.artifactRequests[requestId];
        if (!record || record.channel_id !== id)
          fail("Unknown artifact request", 404);
        if (!["completed", "failed", "cancelled"].includes(status))
          fail("Invalid completion state");
        if (!unresolved(record)) return publicRecord(record);
        const previous = { status: record.status, message: record.message };
        record.status = status;
        record.message =
          typeof message === "string" ? message.slice(0, 500) : null;
        try {
          await persist();
        } catch (error) {
          Object.assign(record, previous);
          throw error;
        }
        return publicRecord(record);
      });
    },
    async request(id, input) {
      let dispatch;
      const record = await locked(async () => {
        const { channel } = scoped(id, input.scope, input.version);
        const expiry = Date.parse(input.expires_at);
        if (
          !uuid(input.request_id) ||
          !uuid(input.binding_id) ||
          !Number.isFinite(expiry) ||
          expiry <= Date.now() ||
          expiry > Date.now() + 10 * 3600000
        )
          fail("Invalid or expired request");
        if (!name(input.action) || !own(channel.actions, input.action))
          fail("Unregistered artifact action", 403);
        const action = channel.actions[input.action];
        const rule = structuredClone(ruleFor(action.rule_id));
        validateArtifactSchema(action.schema, input.data);
        const fingerprint = hash([
          id,
          input.scope,
          input.version,
          input.binding_id,
          input.action,
          input.data,
        ]);
        const previous = state.artifactRequests[input.request_id];
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            fail("Request ID already used with different data", 409);
          return publicRecord(previous);
        }
        for (const [key, item] of Object.entries(state.artifactRequests)) {
          if (Date.parse(item.expires_at) < Date.now() && !unresolved(item))
            delete state.artifactRequests[key];
        }
        if (Object.keys(state.artifactRequests).length >= 4096)
          fail("Too many artifact requests", 429);
        // One in-flight operation per mounted binding also prevents double clicks.
        if (
          Object.values(state.artifactRequests).some(
            (item) => item.binding_id === input.binding_id && unresolved(item),
          )
        )
          fail(
            "An artifact request is still running or its outcome is unknown. Check the automation result.",
            409,
          );
        const entry = {
          request_id: input.request_id,
          channel_id: id,
          binding_id: input.binding_id,
          action: input.action,
          fingerprint,
          expires_at: input.expires_at,
          status: "processing",
          message: null,
        };
        state.artifactRequests[input.request_id] = entry;
        try {
          await persist();
        } catch (error) {
          entry.status = "unknown";
          throw error;
        }
        dispatch = {
          rule,
          event: {
            source: "artifact",
            type: "request",
            id: input.request_id,
            request_id: input.request_id,
            channel_id: id,
            action: input.action,
            data: structuredClone(input.data),
            scope: structuredClone(input.scope),
          },
        };
        return entry;
      });
      if (!dispatch) return record;
      // This calls the existing trusted rule executor, without its automatic retry queue.
      try {
        const result = await runRule(dispatch.rule, dispatch.event);
        await locked(async () => {
          if (record.status !== "processing") return;
          record.status = [
            "accepted",
            "completed",
            "failed",
            "cancelled",
          ].includes(result?.status)
            ? result.status
            : "unknown";
          record.message =
            record.status === "unknown"
              ? "The rule did not confirm completion. Check the automation result."
              : null;
          try {
            await persist();
          } catch (error) {
            record.status = "unknown";
            throw error;
          }
        });
      } catch {
        await locked(async () => {
          if (record.status === "processing") {
            record.status = "unknown";
            record.message =
              "The request failed or its outcome is unknown. Check the automation result before starting new work.";
            await persist();
          }
        });
      }
      return locked(() => publicRecord(record));
    },
  };
}
