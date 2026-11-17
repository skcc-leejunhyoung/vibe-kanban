import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAutopilotShadow } from './autopilot-routing.mjs';

const executionId = '00000000-0000-4000-8000-000000000001';
const hostId = '00000000-0000-4000-8000-000000000002';
const machineId = 'synthetic-native-machine';
const completion = { kind: 'process.completed', executionId, hostId };

function fixture({
  text = 'Routine check complete. No changes.',
  page = {},
  answer,
  response,
} = {}) {
  const h = { requests: [], reads: [] };
  h.readHost = async (item, path, signal) => {
    h.reads.push(path);
    assert.ok(signal instanceof AbortSignal);
    if (path === '/api/automation-actions/status') return { hostId: machineId };
    return {
      data: {
        execution_id: item.executionId,
        status: 'completed',
        total: 2,
        has_more: path.endsWith('limit=1'),
        entries: path.endsWith('limit=1')
          ? []
          : [
              {
                entry_type: { type: 'tool_use' },
                content: 'Synthetic private tool output',
              },
              { entry_type: { type: 'assistant_message' }, content: text },
            ],
        ...page,
      },
    };
  };
  h.fetchImpl = async (url, options) => {
    h.requests.push({ url, options });
    const request = JSON.parse(options.body);
    return (
      response ||
      Response.json({
        model: 'gpt-6-luna',
        answers: request.questions.map(({ name }) => ({
          name,
          type: 'choice',
          choice: 'routine_result',
          confidence: 0.9,
          ...answer,
        })),
        usage: {
          input_tokens: 123,
          private_field: 'Synthetic provider detail',
        },
      })
    );
  };
  h.evaluate = (event = completion, options = {}) =>
    evaluateAutopilotShadow({
      event,
      resolveMachineId: async (id) => {
        assert.equal(id, hostId);
        return machineId;
      },
      readHost: h.readHost,
      fetchImpl: h.fetchImpl,
      apiKey: 'synthetic-key',
      ...options,
    });
  return h;
}

test('completion classification sends only bounded evidence and stores no source text or provider detail', async () => {
  const h = fixture({
    text: `Routine complete. Contact tester@example.test at https://example.test/private. Saved /home/tester/private/report.txt for ${executionId}.`,
  });
  const event = {
    ...completion,
    title: 'Synthetic private title',
    data: { token: 'synthetic-claim' },
  };
  const result = await h.evaluate(event);
  assert.equal(result.status, 'completed');
  assert.equal(result.delivery, 'unchanged');
  assert.equal(result.results[0].route, 'routine_result');
  assert.equal(result.input_tokens, 123);
  const { url, options } = h.requests[0];
  assert.equal(url, 'https://api.openai.com/v1/decisions');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, 'Bearer synthetic-key');
  const body = JSON.parse(options.body);
  assert.equal(body.questions[0].name, 'event_0');
  assert.match(body.input, /\[email\].*\[url\].*\[path\].*\[id\]/);
  for (const value of [
    'tester@example.test',
    'example.test/private',
    '/home/tester',
    executionId,
    'Synthetic private title',
    'synthetic-claim',
    'private tool output',
  ])
    assert.ok(!options.body.includes(value));
  assert.ok(!JSON.stringify(result).includes('Routine complete'));
  assert.ok(!JSON.stringify(result).includes('provider detail'));
});

test('protected events and missing credentials never read completion text or call Decisions', async () => {
  const h = fixture();
  const result = await h.evaluate(
    {
      events: [
        { kind: 'drawer.comment', text: 'Synthetic user instruction' },
        {
          kind: 'cloud.notification',
          notificationClaim: { claim_token: 'synthetic-claim' },
        },
        { kind: 'approval.pending' },
        completion,
      ],
    },
    { apiKey: '' }
  );
  assert.equal(result.status, 'skipped');
  assert.equal(result.results[0].route, 'needs_user');
  assert.equal(result.results[3].reason, 'missing_api_key');
  assert.equal(h.reads.length, 0);
  assert.equal(h.requests.length, 0);
});

test('unresolved event identity, incorrect host, and incomplete snapshots never reach Decisions', async () => {
  const h = fixture();
  await h.evaluate({ ...completion, executionId: '../unexpected' });
  assert.equal(h.reads.length, 0);
  const host = await h.evaluate(completion, {
    readHost: async () => ({ hostId: executionId }),
  });
  assert.equal(host.results[0].reason, 'context_unavailable');
  for (const page of [
    { status: 'running' },
    { execution_id: hostId },
    { has_more: true },
    { total: 0 },
  ]) {
    const invalid = fixture({ page });
    const result = await invalid.evaluate();
    assert.equal(result.results[0].reason, 'context_unavailable');
    assert.equal(invalid.requests.length, 0);
  }
  assert.equal(h.requests.length, 0);
});

test('credential-shaped completion text is excluded before any external request', async () => {
  for (const text of [
    'Synthetic response with Bearer synthetic-credential',
    `Synthetic response with ${['sk', 'synthetic-credential-material'].join('-')}`,
    'Synthetic response with api_key=synthetic-credential',
    '{"password": "synthetic-password"}',
    '{"access_token": "synthetic-credential"}',
    '{"client_secret": "synthetic-oauth-material"}',
    '{"clientSecret": "synthetic-oauth-material"}',
    'OPENAI_API_KEY=synthetic-provider-material',
    'AWS_SECRET_ACCESS_KEY=synthetic-provider-material',
    'SERVICE_REFRESH_TOKEN=synthetic-provider-material',
    'service-private-key: synthetic-private-material',
    'Synthetic response with Basic synthetic-credential',
    'Synthetic response with eyJsynthetic.synthetic.synthetic',
    '-----BEGIN SYNTHETIC PRIVATE KEY-----',
  ]) {
    const h = fixture({ text });
    const result = await h.evaluate();
    assert.equal(result.results[0].reason, 'context_unavailable');
    assert.equal(h.requests.length, 0);
  }
});

test('escaped JSON and bracket assignments never send opaque credentials', async () => {
  const material = 'synthetic-opaque-oauth-material';
  const plain = JSON.stringify({ client_secret: material });
  for (const text of [
    JSON.stringify({ response: plain }),
    JSON.stringify(JSON.stringify(plain)),
    `config["client_secret"] = "${material}";`,
    `config['clientSecret'] = '${material}';`,
    `config[\`client_secret\`] = '${material}';`,
    `env["SERVICE_API_KEY"] = '${material}';`,
    JSON.stringify({ response: `env["SERVICE_API_KEY"] = '${material}';` }),
  ]) {
    const h = fixture({ text });
    const result = await h.evaluate();
    assert.equal(result.results[0].reason, 'context_unavailable');
    assert.equal(h.requests.length, 0);
    assert.ok(!JSON.stringify(result).includes(material));
  }
  const h = fixture({
    text: 'Documented client_secret without assigning any value.',
  });
  assert.equal((await h.evaluate()).status, 'completed');
  assert.equal(h.requests.length, 1);
});

test('oversized source text is excluded before expensive scanning, including UTF-8 byte limits', async () => {
  for (const text of [
    'client_secret'.repeat(30000),
    'r'.repeat(16385),
    '한'.repeat(6000),
  ]) {
    const h = fixture({ text });
    const result = await h.evaluate();
    assert.equal(result.results[0].reason, 'context_unavailable');
    assert.equal(h.requests.length, 0);
  }
  const h = fixture({ text: 'r'.repeat(16384) });
  assert.equal((await h.evaluate()).status, 'completed');
  assert.equal(h.requests.length, 1);
});

test('excluded evidence cannot leak into the request for another event in the batch', async () => {
  for (const text of [
    JSON.stringify({
      response: JSON.stringify({ client_secret: 'synthetic-batch-material' }),
    }),
    'client_secret'.repeat(30000),
  ]) {
    const h = fixture({ text });
    const readHost = h.readHost;
    h.readHost = async (item, path, signal) => {
      const response = await readHost(item, path, signal);
      if (item.executionId !== executionId && response.data)
        response.data.entries = response.data.entries.map((entry) => ({
          ...entry,
          content: 'Synthetic routine complete.',
        }));
      return response;
    };
    const result = await h.evaluate({
      events: [
        completion,
        { ...completion, executionId: '00000000-0000-4000-8000-000000000003' },
      ],
    });
    assert.equal(result.results[0].reason, 'context_unavailable');
    assert.equal(result.results[1].source, 'decisions');
    assert.equal(h.requests.length, 1);
    const request = JSON.parse(h.requests[0].options.body);
    assert.deepEqual(
      request.questions.map(({ name }) => name),
      ['event_1']
    );
    assert.ok(!request.input.includes('synthetic-batch-material'));
    assert.ok(!request.input.includes('client_secret'));
  }
});

test('synchronous collection cannot start a paid request after its deadline', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const h = fixture();
  const readHost = h.readHost;
  h.readHost = async (item, path, signal) => {
    const response = await readHost(item, path, signal);
    if (path.endsWith('limit=20')) now += 3000;
    return response;
  };
  const result = await h.evaluate();
  assert.equal(result.status, 'fallback');
  assert.equal(result.reason, 'timeout');
  assert.equal(h.requests.length, 0);
});

test('redaction happens before truncation so a long URL or path cannot leak its suffix', async () => {
  for (const text of [
    `https://example.test/${'synthetic-private-segment/'.repeat(150)}`,
    `/home/synthetic/${'synthetic-private-segment/'.repeat(150)}`,
  ]) {
    const h = fixture({ text });
    await h.evaluate();
    assert.equal(h.requests.length, 1);
    assert.ok(
      !h.requests[0].options.body.includes('synthetic-private-segment')
    );
    assert.equal(
      JSON.parse(JSON.parse(h.requests[0].options.body).input)[0].truncated,
      true
    );
  }
});

test('unresolved machine identity never reads host data and cannot trust event-supplied identity', async () => {
  for (const machine of [undefined, '', 42]) {
    const h = fixture();
    const result = await h.evaluate(
      { ...completion, machineId },
      {
        resolveMachineId: async () => machine,
      }
    );
    assert.equal(result.results[0].reason, 'context_unavailable');
    assert.equal(h.reads.length, 0);
    assert.equal(h.requests.length, 0);
  }
  const h = fixture();
  const readHost = h.readHost;
  h.readHost = (item, ...args) => {
    assert.equal(item.machineId, machineId);
    return readHost(item, ...args);
  };
  assert.equal(
    (await h.evaluate({ ...completion, machineId: 'untrusted-host' })).status,
    'completed'
  );
});

test('a mixed batch preserves indexes and asks one question per eligible completion', async () => {
  const h = fixture();
  const result = await h.evaluate({
    events: [
      { kind: 'approval.pending' },
      completion,
      { kind: 'process.failed' },
      completion,
    ],
  });
  assert.equal(h.requests.length, 1);
  const request = JSON.parse(h.requests[0].options.body);
  assert.deepEqual(
    request.questions.map((q) => q.name),
    ['event_1', 'event_3']
  );
  assert.deepEqual(
    result.results.map((r) => r.source),
    ['rule', 'decisions', 'rule', 'decisions']
  );
  assert.equal(result.delivery, 'unchanged');
});

test('batch and byte limits bound model input instead of silently classifying partial evidence', async () => {
  const h = fixture();
  const result = await h.evaluate({
    events: Array.from({ length: 9 }, () => completion),
  });
  assert.equal(JSON.parse(h.requests[0].options.body).questions.length, 8);
  assert.equal(result.results.length, 8);
  assert.equal(result.omitted_events, 1);
  const large = fixture({ text: '가'.repeat(2001) });
  const bounded = await large.evaluate({
    events: Array.from({ length: 8 }, () => completion),
  });
  assert.equal(bounded.reason, 'input_limit');
  assert.equal(large.requests.length, 0);
});

test('truncated completion text is explicitly marked as incomplete evidence', async () => {
  const h = fixture({ text: 'x'.repeat(2001) });
  await h.evaluate();
  const input = JSON.parse(JSON.parse(h.requests[0].options.body).input);
  assert.equal(input[0].truncated, true);
  assert.equal(input[0].result_text.length, 2000);
});

test('invalid answers fail closed without storing arbitrary provider output', async () => {
  for (const answer of [
    { type: 'unexpected' },
    { choice: 'execute_command' },
    { name: 'event_99' },
    { confidence: 1.1 },
    { confidence: '0.9' },
  ]) {
    const h = fixture({ answer });
    const result = await h.evaluate();
    assert.equal(result.status, 'fallback');
    assert.ok(result.results.every((r) => r.route === 'needs_investigation'));
  }
});

test('missing, duplicate, or wrong-model answers cannot be mistaken for a complete classification', async () => {
  for (const data of [
    { model: 'gpt-6-luna', answers: [] },
    { model: 'unexpected', answers: [] },
    {
      model: 'gpt-6-luna',
      answers: [
        {
          name: 'event_0',
          type: 'choice',
          choice: 'routine_result',
          confidence: 0.9,
        },
        {
          name: 'event_0',
          type: 'choice',
          choice: 'routine_result',
          confidence: 0.9,
        },
      ],
    },
  ]) {
    const h = fixture({ response: Response.json(data) });
    const result = await h.evaluate();
    assert.equal(result.status, 'fallback');
  }
});

test('refusals retain the agent route and low confidence remains advisory', async () => {
  const refused = await fixture({ answer: { type: 'refusal' } }).evaluate();
  assert.equal(refused.results[0].reason, 'refusal');
  assert.equal(refused.results[0].route, 'needs_investigation');
  const uncertain = await fixture({ answer: { confidence: 0.1 } }).evaluate();
  assert.equal(uncertain.results[0].confidence, 0.1);
  assert.equal(uncertain.delivery, 'unchanged');
});

test('mixed batches preserve event identity while bounding observation count and request size', async () => {
  const h = fixture();
  const result = await h.evaluate({
    events: [{ kind: 'approval.pending' }, ...Array(8).fill(completion)],
  });
  assert.equal(result.omitted_events, 1);
  assert.equal(result.results.length, 8);
  assert.equal(result.results[0].route, 'needs_user');
  assert.equal(result.results[1].source, 'decisions');
  assert.equal(h.requests.length, 1);
  const questions = JSON.parse(h.requests[0].options.body).questions;
  assert.equal(questions.length, 7);
  assert.equal(questions[0].name, 'event_1');
  const large = fixture({ text: '가'.repeat(2000) });
  const limited = await large.evaluate({ events: Array(8).fill(completion) });
  assert.equal(limited.reason, 'input_limit');
  assert.equal(large.requests.length, 0);
});

test('HTTP failures and malformed or oversized bodies produce only safe fallback metadata', async () => {
  for (const response of [
    new Response('Synthetic private provider error', { status: 429 }),
    new Response('not json'),
    new Response('x'.repeat(65537)),
  ]) {
    const result = await fixture({ response }).evaluate();
    assert.equal(result.status, 'fallback');
    assert.ok(!JSON.stringify(result).includes('Synthetic private'));
  }
});

test('a hung collector or provider is bounded even if it ignores cancellation', async () => {
  const never = () => new Promise(() => {});
  const late = fixture();
  let resolveHost;
  const resolver = await late.evaluate(completion, {
    resolveMachineId: () =>
      new Promise((resolve) => {
        resolveHost = resolve;
      }),
    timeoutMs: 10,
  });
  assert.equal(resolver.reason, 'timeout');
  resolveHost(machineId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.reads.length, 0);
  assert.equal(late.requests.length, 0);
  const h = fixture();
  const collector = await h.evaluate(completion, {
    readHost: never,
    timeoutMs: 10,
  });
  assert.equal(collector.reason, 'timeout');
  const provider = await h.evaluate(completion, {
    fetchImpl: never,
    timeoutMs: 10,
  });
  assert.equal(provider.reason, 'timeout');
  assert.equal(h.requests.length, 0);
});
