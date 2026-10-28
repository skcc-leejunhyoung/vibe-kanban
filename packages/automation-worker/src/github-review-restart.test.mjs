import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/review-request.json', import.meta.url))
);
const serverSource = await readFile(
  new URL('./server.mjs', import.meta.url),
  'utf8'
);
const importScript = serverSource.match(
  /const defaultGithubRuleScript = (`[^]*?`);/
)[1];
const evaluatedScript = Function(`return ${importScript}`)();

async function waitFor(check, timeout = 8000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for isolated worker: ${lastError?.message || 'condition not met'}`
  );
}

// Real worker processes and state.json; only GitHub/Vibe HTTP are loopback doubles.
// No configured host, credential, or production endpoint is read or changed.
test(
  'a killed worker recovers a committed create before its checkpoint, then updates the original repo head',
  { timeout: 25000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'vibe-review-restart-')
    );
    const projectId = '11111111-1111-4111-8111-111111111111';
    const statusId = '22222222-2222-4222-8222-222222222222';
    const repos = ['example/app', 'example/search'];
    const heads = {
      [repos[0]]: 'c'.repeat(40),
      [repos[1]]: fixture.details.head.sha,
    };
    const issues = new Map();
    const tags = new Set();
    const links = [];
    const changes = [];
    let creates = 0;
    let killed = false;
    let child;
    let exited;
    let diagnostics = '';
    let resolveCrash;
    const crashed = new Promise((resolve) => {
      resolveCrash = resolve;
    });
    const mock = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://loopback');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : null;
      const send = (data, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      try {
        if (url.pathname === '/search/issues') {
          const repo = url.searchParams.get('q').match(/^repo:([^ ]+)/)[1];
          assert.ok(repos.includes(repo));
          return send({
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                ...fixture.searchItem,
                repository_url: `https://api.github.com/repos/${repo}`,
                html_url: `https://github.com/${repo}/pull/42`,
              },
            ],
          });
        }
        if (/^\/repos\/.+\/pulls\/42$/.test(url.pathname)) {
          const repo = url.pathname.split('/').slice(2, 4).join('/');
          return send({
            ...fixture.details,
            head: { ...fixture.details.head, sha: heads[repo] },
          });
        }
        if (url.pathname === '/repos/example/app/issues') return send([]);
        if (url.pathname === '/v1/pull_request_issues' && req.method === 'GET')
          return send({
            pull_request_issues: links.filter(
              (link) => link.url === url.searchParams.get('url')
            ),
          });
        if (url.pathname.startsWith('/v1/issues/') && req.method === 'GET') {
          const issue = issues.get(url.pathname.split('/').at(-1));
          return send(issue || { error: 'not found' }, issue ? 200 : 404);
        }
        if (url.pathname === '/v1/issues' && req.method === 'POST') {
          assert.equal(req.headers['idempotency-key'], undefined);
          assert.match(
            payload.id,
            /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
          );
          if (issues.has(payload.id))
            return send({ error: 'duplicate primary key' }, 500);
          creates += 1;
          issues.set(payload.id, { ...payload, id: payload.id });
          if (
            !killed &&
            payload.extension_metadata.github_repository === repos[1]
          ) {
            killed = true;
            child.kill('SIGKILL');
            res.destroy();
            resolveCrash();
            return;
          }
          return send({ data: issues.get(payload.id), txid: 1 });
        }
        if (url.pathname.startsWith('/v1/issues/') && req.method === 'PATCH') {
          const issue = issues.get(url.pathname.split('/').at(-1));
          Object.assign(issue, payload);
          return send({ data: issue, txid: 2 });
        }
        if (url.pathname === '/v1/tags')
          return send({ tags: [{ id: 'review-tag', name: 'review' }] });
        if (url.pathname === '/v1/issue_tags' && req.method === 'GET') {
          const issueId = url.searchParams.get('issue_id');
          return send({
            issue_tags: tags.has(issueId)
              ? [{ issue_id: issueId, tag_id: 'review-tag' }]
              : [],
          });
        }
        if (url.pathname === '/v1/issue_tags' && req.method === 'POST') {
          assert.ok(
            links.some((link) => link.issue_id === payload.issue_id),
            'review-ready notification must follow the PR link'
          );
          assert.equal(
            tags.has(payload.issue_id),
            false,
            'must not reattach an existing review tag'
          );
          tags.add(payload.issue_id);
          return send({ data: payload });
        }
        if (
          url.pathname === '/v1/pull_request_issues' &&
          req.method === 'POST'
        ) {
          assert.equal(
            links.some(
              (link) =>
                link.url === payload.url && link.issue_id === payload.issue_id
            ),
            false
          );
          links.push({ ...payload, project_id: projectId });
          return send({ data: payload });
        }
        if (url.pathname === '/head-events') {
          changes.push(payload);
          return send({});
        }
        throw new Error(
          `Unexpected isolated API request: ${req.method} ${url.pathname}`
        );
      } catch (error) {
        diagnostics += `${error.stack}\n`;
        if (!res.destroyed) send({ error: error.message }, 500);
      }
    });
    mock.listen(0, '127.0.0.1');
    await once(mock, 'listening');
    const apiBase = `http://127.0.0.1:${mock.address().port}`;
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const workerPort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const workerBase = `http://127.0.0.1:${workerPort}`;
    const statePath = path.join(directory, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        enabled: true,
        connectors: [
          {
            id: 'github-default',
            type: 'github',
            enabled: true,
            config: {
              token: 'fixture',
              username: fixture.login,
              owner: 'example',
              repo: 'app',
              apiBase,
              reviewPrs: true,
              reviewRepositories: repos,
              notifyPrComments: false,
              intervalSeconds: 3600,
            },
          },
          {
            id: 'vibe-default',
            type: 'vibe_kanban',
            enabled: true,
            config: {
              baseUrl: apiBase,
              bearerToken: 'fixture',
              projectId,
              statusId,
            },
          },
        ],
        rules: [
          { id: 'review-import', enabled: true, script: evaluatedScript },
          {
            id: 'head-update',
            enabled: true,
            script: `async function handle(event, ctx) { if (event.type === 'pr_updated') await ctx.actions.http.request('${apiBase}/head-events', {method:'POST', body:JSON.stringify({repo:event.repo,number:event.number,headSha:event.headSha})}); }`,
          },
          {
            id: 'github-issue-to-vibe',
            enabled: false,
            kind: 'github_issue_sync',
            config: {},
            script: '',
          },
        ],
      })
    );
    const start = () => {
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./server.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            AUTOMATION_DATA_DIR: directory,
            HOST: '127.0.0.1',
            PORT: String(workerPort),
            ADMIN_TOKEN: 'isolated-fixture-token',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        }
      );
      child.stderr.on('data', (data) => {
        diagnostics += data.toString().slice(0, 2000);
      });
      exited = once(child, 'exit');
    };
    try {
      start();
      await Promise.race([
        crashed,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error(`Crash injection not reached: ${diagnostics}`)),
            8000
          );
          timer.unref();
        }),
      ]);
      await exited;
      assert.equal(issues.size, 2);
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(
        saved.connectors.find((connector) => connector.id === 'github-default')
          .config.reviewPrTargets?.['example/search#42'],
        undefined
      );
      start();
      const headers = { authorization: 'Bearer isolated-fixture-token' };
      await waitFor(async () => {
        const response = await fetch(`${workerBase}/api/state`, { headers });
        if (!response.ok) return false;
        const current = await response.json();
        const reconciliation = current.connectors.find(
          (c) => c.id === 'github-default'
        ).config.reviewPrReconciliation;
        return (
          reconciliation?.complete &&
          reconciliation.open.length === 2 &&
          reconciliation.missing.length === 0
        );
      });
      assert.equal(creates, 2);
      assert.equal(issues.size, 2);
      assert.equal(tags.size, 2);
      assert.equal(links.length, 2);
      heads[repos[1]] = 'b'.repeat(40);
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${workerBase}/api/poll/github-default`, {
          method: 'POST',
          headers,
        });
        assert.equal(response.status, 200, diagnostics);
      }
      assert.equal(creates, 2);
      assert.equal(changes.length, 1);
      assert.deepEqual(changes[0], {
        repo: repos[1],
        number: 42,
        headSha: heads[repos[1]],
      });
      const issue = [...issues.values()].find(
        (issue) => issue.extension_metadata.github_repository === repos[1]
      );
      assert.equal(issue.extension_metadata.github_head_sha, heads[repos[1]]);
      assert.equal(diagnostics, '');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
      mock.closeAllConnections();
      await new Promise((resolve) => mock.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
