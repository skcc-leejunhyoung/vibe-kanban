import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import {
  githubReviewRepositories,
  searchGithubPrs,
  reconcileGithubReviewPrs,
  githubReviewIssueId,
  githubReviewRuleVersion,
} from "./github-review-prs.mjs";
import { githubIssueLinkKey } from "./github-sub-issues.mjs";
import { selectPullRequestLinkForProject } from "./pull-request-links.mjs";
import {
  githubIssueSyncVibeConnectorId,
  shouldRunGithubIssueSyncRule,
  normalizeOptionalTimestamp,
  githubIssuePollSince,
  selectGithubPollCandidates,
  selectGithubImportCandidates,
  markGithubIssueSeen,
} from "./github-issue-sync.mjs";

const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/review-request.json", import.meta.url)),
);
const script = vm.runInNewContext(
  source.match(/const defaultGithubRuleScript = (`[^]*?`);/)[1],
);
const repository = "example/search";
const pr = { ...fixture.searchItem, repository };
const headA = fixture.details.head.sha;
const headB = "b".repeat(40);
function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing production function ${name}`);
  return source.slice(match.index, source.indexOf("\n}\n", match.index) + 2);
}
const names = [
  "processRetryQueue",
  "removeRetryItem",
  "undeliveredGithubReviewRules",
  "getGithubReviewIssue",
  "findGithubReviewIssue",
  "ensureGithubReviewIssueReady",
  "reconcileGithubReviewTargets",
  "githubSearchPrs",
  "githubPerPage",
  "githubHeaders",
  "githubPrBranches",
  "pollGithubReviews",
  "findPullRequestLinkByUrl",
  "createVibeIssue",
  "postVibeIssue",
  "runRules",
  "runRule",
  "createRuleContext",
  "pollGithub",
  "pollGithubPrComments",
  "pollGithubRepositoryPrComments",
  "githubCommentPrNumber",
  "orderByParent",
];

function harness(options = {}) {
  const github = {
    id: "github",
    type: "github",
    enabled: true,
    config: {
      token: "synthetic",
      owner: "example",
      repo: "app",
      reviewPrs: true,
      reviewRepositories: [repository],
      notifyPrComments: false,
      cursorTs: "2026-10-27T00:00:00Z",
      seenIds: ["old"],
      seenNumbers: [],
    },
  };
  const target = {
    id: "vibe-default",
    type: "vibe_kanban",
    enabled: true,
    config: {
      baseUrl: "https://fixture.invalid",
      projectId: "project-target",
      statusId: "todo",
    },
  };
  const state = options.state || {
    connectors: [github, target],
    rules: [{ id: "import", enabled: true, script }],
    retryQueue: [],
    pullRequestLinkOperations: [],
  };
  const store = options.store || {
    issues: new Map(),
    links: [],
    receipts: new Map(),
    tags: new Set(),
  };
  const h = {
    options,
    state,
    store,
    events: [],
    requests: [],
    logs: [],
    head: headA,
    persisted: null,
    crashSnapshot: null,
    tagCalls: 0,
  };
  const context = vm.createContext({
    vm,
    randomUUID,
    URLSearchParams,
    Set,
    Map,
    Date,
    structuredClone,
    githubReviewRepositories,
    searchGithubPrs,
    reconcileGithubReviewPrs,
    githubReviewIssueId,
    githubReviewRuleVersion,
    githubIssueLinkKey,
    selectPullRequestLinkForProject,
    githubIssueSyncVibeConnectorId,
    shouldRunGithubIssueSyncRule,
    normalizeOptionalTimestamp,
    githubIssuePollSince,
    selectGithubPollCandidates,
    selectGithubImportCandidates,
    markGithubIssueSeen,
    RETRY_MAX_ATTEMPTS: 5,
    RULE_TIMEOUT_MS: 10000,
    state,
    retryInFlight: new Set(),
    routineInFlight: new Set(),
    routineHostInFlight: new Set(),
    cloneData: structuredClone,
    withTimeout: async (p) => p,
    findConnector: (id) => {
      const c = state.connectors.find((c) => c.id === id);
      assert.ok(c);
      return c;
    },
    errorMessage: (e) => e.message,
    retryDelay: () => 60000,
    log: async (level, message, meta) => h.logs.push({ level, message, meta }),
    persistState: async () => {
      h.persisted = structuredClone(state);
      const hasMap = state.connectors.some(
        (c) => Object.keys(c.config.reviewPrIssueMap || {}).length,
      );
      if (options.crashAtMap && hasMap && !h.crashSnapshot) {
        h.crashSnapshot = structuredClone(state);
        throw new Error(
          "simulated crash after persisted review map, before PR link",
        );
      }
    },
    enqueueRetry: async (rule, event, error) =>
      state.retryQueue.push({
        id: randomUUID(),
        attempts: 1,
        maxAttempts: 5,
        nextAttemptAt: Date.now() + 60000,
        ruleId: rule.id,
        connectorId: event.connectorId,
        event: structuredClone(event),
        status: "pending",
        lastError: error.message,
      }),
    resolveVibeTag: async () => {
      h.tagCalls += 1;
      if (options.failTag) throw new Error("tag API 503");
      return "review-tag";
    },
    attachVibeTag: async (_, id) => store.tags.add(id),
    retryPendingPullRequestLinks: async () => {},
    githubLogin: async () => fixture.login,
    reconcileGithubIssueRules: async () => ({ synced: 0 }),
    githubParentMap: async () => ({}),
    githubRelatedPrs: async (_, __, repo) => {
      if (options.failCommentRepository === repo)
        throw new Error(`GitHub 403 for ${repo}`);
      return [];
    },
    githubPrComments: async () => [],
    githubPrReviews: async () => [],
    recentlyUpdatedPrs: (prs) => prs,
    vibeApi: async (connector, method, endpoint, payload, __, meta) => {
      h.requests.push({ target: connector.id, method, endpoint });
      if (method === "GET" && endpoint.startsWith("/v1/pull_request_issues?")) {
        if (options.failTarget === connector.id)
          throw new Error("Unrelated Vibe target unavailable");
        const url = new URLSearchParams(endpoint.split("?")[1]).get("url");
        return {
          pull_request_issues: store.links.filter((link) => link.url === url),
        };
      }
      if (method === "GET" && endpoint.startsWith("/v1/issues/")) {
        const id = endpoint.split("/").at(-1);
        if (!store.issues.has(id))
          throw Object.assign(new Error("not found"), { status: 404 });
        return { ...structuredClone(store.issues.get(id)), id };
      }
      if (method === "PATCH" && endpoint.startsWith("/v1/issues/")) {
        const issue = store.issues.get(endpoint.split("/").at(-1));
        Object.assign(issue, structuredClone(payload));
        return { data: issue };
      }
      if (method === "GET" && endpoint.startsWith("/v1/issue_tags?")) {
        const id = new URLSearchParams(endpoint.split("?")[1]).get("issue_id");
        return {
          issue_tags: store.tags.has(id)
            ? [{ issue_id: id, tag_id: "review-tag" }]
            : [],
        };
      }
      if (method === "POST" && endpoint === "/v1/issues") {
        const id = payload.id || `issue-${store.issues.size + 1}`;
        assert.equal(meta?.idempotencyKey, undefined);
        if (store.issues.has(id))
          throw Object.assign(new Error("duplicate issue id"), { status: 500 });
        store.issues.set(id, structuredClone(payload));
        if (options.loseCreateResponse) {
          options.loseCreateResponse = false;
          throw new Error("response lost");
        }
        return { data: { id } };
      }
      if (method === "POST" && endpoint === "/v1/pull_request_issues") {
        if (options.failLink) throw new Error("PR link API 503");
        if (
          !store.links.some(
            (link) =>
              link.url === payload.url && link.issue_id === payload.issue_id,
          )
        )
          store.links.push({
            ...payload,
            project_id: connector.config.projectId,
          });
        return {};
      }
      throw new Error(`Unexpected mock endpoint ${method} ${endpoint}`);
    },
    fetch: async (input) => {
      const url = new URL(input);
      h.requests.push({ method: "GET", endpoint: url.pathname });
      if (url.pathname === "/search/issues")
        return {
          ok: true,
          json: async () => ({
            total_count: 1,
            incomplete_results: false,
            items: [h.sourcePr || fixture.searchItem],
          }),
        };
      if (url.pathname.endsWith("/pulls/42"))
        return {
          ok: true,
          json: async () => ({
            ...fixture.details,
            head: { ...fixture.details.head, sha: h.head },
          }),
        };
      if (url.pathname === "/repos/example/app/issues")
        return {
          ok: true,
          text: async () =>
            JSON.stringify([
              {
                id: 991,
                number: 991,
                title: "ordinary assigned issue",
                state: "open",
                html_url: "https://github.com/example/app/issues/991",
                updated_at: "2026-10-28T00:00:00Z",
              },
            ]),
        };
      throw new Error(`Unexpected mock GitHub endpoint ${url.pathname}`);
    },
  });
  vm.runInContext(names.map(functionSource).join("\n"), context);
  const realRunRules = context.runRules;
  context.runRules = async (event) => {
    h.events.push(structuredClone(event));
    return realRunRules(event);
  };
  h.context = context;
  h.github = state.connectors.find((c) => c.type === "github");
  h.target = state.connectors.find((c) => c.id === "vibe-default");
  h.poll = () => context.pollGithubReviews(h.github, fixture.login);
  return h;
}

test("recovers a crash after the issue map commit without another issue or manual link", async () => {
  const h = harness({ crashAtMap: true });
  const event = {
    source: "github",
    type: "pr",
    connectorId: "github",
    repo: repository,
    number: 42,
    url: pr.html_url,
    title: pr.title,
    state: "open",
    headSha: headA,
    headRef: fixture.details.head.ref,
    baseRef: "main",
    raw: pr,
  };
  await assert.rejects(
    h.context.createVibeIssue(
      "vibe-default",
      { title: pr.title, sourceKey: `${repository}#42`, tags: ["review"] },
      event,
      { id: "import", script },
    ),
    /simulated crash/,
  );
  const resumed = harness({ state: h.crashSnapshot, store: h.store });
  const result = await resumed.poll();
  assert.equal(resumed.store.issues.size, 1);
  assert.equal(resumed.store.links.length, 1);
  assert.equal(resumed.store.tags.size, 1);
  assert.equal(result.open[0].status, "tracked");
  assert.equal(result.missing.length, 0);
});

test("recovers a create response loss and a server restart before any worker checkpoint", async () => {
  const h = harness({ loseCreateResponse: true });
  let result = await h.poll();
  assert.equal(result.missing.length, 0);
  assert.equal(h.store.issues.size, 1);
  const id = githubReviewIssueId(h.target.config.projectId, pr.html_url);
  assert.ok(h.store.issues.has(id));
  const resumed = harness({ store: h.store });
  result = await resumed.poll();
  assert.equal(result.missing.length, 0);
  assert.equal(resumed.store.issues.size, 1);
  assert.equal(
    resumed.requests.filter(
      (r) => r.method === "POST" && r.endpoint === "/v1/issues",
    ).length,
    0,
  );
  assert.match(
    id,
    /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.notEqual(id, githubReviewIssueId("another-project", pr.html_url));
  assert.notEqual(
    id,
    githubReviewIssueId(
      h.target.config.projectId,
      "https://github.com/example/app/pull/42",
    ),
  );
});

test("a failed review tag stays missing and is repaired in place on the next poll", async () => {
  const h = harness({ failTag: true });
  let result = await h.poll();
  assert.equal(result.missing.length, 1);
  assert.equal(result.complete, false);
  assert.equal(h.store.tags.size, 0);
  assert.ok(result.errors[0].error.includes("tag API 503"));
  h.options.failTag = false;
  await h.context.processRetryQueue({ force: true });
  result = await h.poll();
  assert.equal(result.open[0].status, "tracked");
  assert.equal(h.store.issues.size, 1);
  assert.equal(h.store.tags.size, 1);
  assert.equal(h.store.links.length, 1);
});

test("failed or removed PR links are reconstructed from the actual destination after restart", async () => {
  const h = harness({ failLink: true });
  let result = await h.poll();
  assert.equal(result.missing.length, 1);
  assert.equal(
    h.store.tags.size,
    0,
    "review-ready tag must wait for a structural PR link",
  );
  h.options.failLink = false;
  const resumed = harness({ state: structuredClone(h.state), store: h.store });
  await resumed.context.processRetryQueue({ force: true });
  result = await resumed.poll();
  assert.equal(result.missing.length, 0);
  assert.equal(resumed.store.issues.size, 1);
  assert.equal(resumed.store.links.length, 1);
  resumed.store.links = [];
  result = await resumed.poll();
  assert.equal(resumed.store.links.length, 1);
  assert.equal(result.missing.length, 0);
});

test("unrelated projects and unavailable Vibe connectors do not suppress the intended destination", async () => {
  const h = harness({ failTarget: "vibe-other" });
  h.state.connectors.push({
    id: "vibe-other",
    type: "vibe_kanban",
    enabled: true,
    config: { projectId: "project-other", baseUrl: "https://other.invalid" },
  });
  h.store.links.push({
    url: pr.html_url,
    issue_id: "issue-in-other-project",
    project_id: "project-other",
  });
  const result = await h.poll();
  assert.equal(h.store.issues.size, 1);
  assert.notEqual(result.open[0].issueId, "issue-in-other-project");
  assert.equal(result.open[0].targets[0].projectId, h.target.config.projectId);
  assert.equal(result.missing.length, 0);
  assert.equal(
    h.requests.filter((request) => request.target === "vibe-other").length,
    0,
  );
});

test("a failed added repository leaves its activity cursor unchanged and still imports primary assigned issues", async () => {
  const h = harness({ failCommentRepository: repository });
  h.github.config.reviewRepositories = ["example/app", repository];
  h.github.config.notifyPrComments = true;
  const cursor = "2026-10-27T00:00:00Z";
  h.github.config.prCommentCursors = Object.fromEntries(
    ["example/app", repository].map((repo) => [
      repo,
      { cursorTs: cursor, seenIds: [] },
    ]),
  );
  h.context.pollGithubReviews = async () => ({ processed: 0 });
  await h.context.pollGithub(h.github);
  assert.equal(
    h.requests.filter(
      (request) => request.endpoint === "/repos/example/app/issues",
    ).length,
    1,
  );
  assert.equal(h.store.issues.size, 1);
  assert.equal(h.github.config.prCommentCursors[repository].cursorTs, cursor);
  assert.ok(h.github.config.prCommentCursors["example/app"].cursorTs > cursor);
  assert.equal(h.github.config.prCommentErrors[0].repository, repository);
});

test("head changes update the existing issue metadata and deliver one source-correct change event", async () => {
  const h = harness();
  await h.poll();
  h.head = headB;
  let result = await h.poll();
  await h.poll();
  assert.equal(h.store.issues.size, 1);
  const issue = [...h.store.issues.values()][0];
  assert.equal(issue.extension_metadata.github_head_sha, headB);
  const changes = h.events.filter((event) => event.type === "pr_updated");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].repo, repository);
  assert.equal(changes[0].previousHeadSha, headA);
  assert.equal(result.open[0].headSha, headB);
  assert.equal(h.requests.filter((r) => r.method === "PATCH").length, 1);
});

test("converts a previously assigned PR to review in place without replacing its source mapping", async () => {
  for (const sourceRepository of [repository, repository.toUpperCase()]) {
    const h = harness();
    h.github.config.includePullRequests = true;
    const event = {
      source: "github",
      type: "issue",
      connectorId: "github",
      repo: sourceRepository,
      number: 42,
      url: pr.html_url,
      title: pr.title,
      state: "open",
      raw: pr,
    };
    await h.context.createVibeIssue(
      "vibe-default",
      { title: pr.title, sourceKey: `${sourceRepository}#42` },
      event,
      { id: "import", script },
    );
    const prior = h.target.config.issueMap[`${sourceRepository}#42`];
    const result = await h.poll();
    assert.equal(h.store.issues.size, 1);
    assert.equal(h.target.config.issueMap[`${repository}#42`], prior);
    assert.equal(result.open[0].issueId, prior);
    assert.equal(h.store.tags.size, 1);
    assert.equal(h.store.links[0].issue_id, prior);
  }
});

test("destination changes use project-scoped identity and preserve the old project issue", async () => {
  const h = harness();
  await h.poll();
  const prior = [...h.store.issues.keys()][0];
  h.target.config.projectId = "project-new";
  const result = await h.poll();
  assert.equal(h.store.issues.size, 2);
  assert.notEqual(result.open[0].issueId, prior);
  assert.equal(h.store.issues.get(prior).project_id, "project-target");
  assert.equal(result.open[0].targets[0].projectId, "project-new");
});

test("successful discovery scripts do not repeat arbitrary HTTP actions on reconciliation or restart", async () => {
  const h = harness();
  let sideEffects = 0;
  const originalFetch = h.context.fetch;
  h.context.fetch = async (url, opts) => {
    if (url === "https://side-effect.invalid") {
      sideEffects += 1;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => "",
      };
    }
    return originalFetch(url, opts);
  };
  h.state.rules.push({
    id: "side-effect",
    enabled: true,
    script:
      "async function handle(event, ctx) { if (event.type === 'pr') await ctx.actions.http.request('https://side-effect.invalid'); }",
  });
  await h.poll();
  await h.poll();
  await h.poll();
  assert.equal(sideEffects, 1);
  assert.equal(h.store.issues.size, 1);
  const resumed = harness({ state: structuredClone(h.state), store: h.store });
  await resumed.poll();
  assert.equal(resumed.events.filter((event) => event.type === "pr").length, 0);
});

test("adopts the manual TEST-1001 recovery in the intended project without a second issue", async () => {
  const h = harness();
  h.store.issues.set("TEST-1001", {
    project_id: h.target.config.projectId,
    extension_metadata: {},
  });
  h.store.links.push({
    url: pr.html_url,
    issue_id: "TEST-1001",
    project_id: h.target.config.projectId,
  });
  const result = await h.poll();
  assert.equal(h.store.issues.size, 1);
  assert.equal(result.open[0].issueId, "TEST-1001");
  assert.equal(result.open[0].status, "tracked");
  assert.equal(
    h.requests.filter((r) => r.method === "POST" && r.endpoint === "/v1/issues")
      .length,
    0,
  );
});

test("a new enabled import rule registers its own destination once without replaying earlier rules", async () => {
  const h = harness();
  await h.poll();
  h.state.connectors.push({
    id: "second",
    type: "vibe_kanban",
    enabled: true,
    config: {
      projectId: "second-project",
      baseUrl: "https://second.invalid",
      statusId: "todo",
    },
  });
  h.state.rules.push({
    id: "second-import",
    enabled: true,
    script: script.replaceAll("vibe-default", "second"),
  });
  await h.poll();
  const result = await h.poll();
  assert.equal(h.store.issues.size, 2);
  assert.equal(result.open[0].targets.length, 2);
  assert.equal(result.missing.length, 0);
  assert.equal(
    h.requests.filter((r) => r.method === "POST" && r.endpoint === "/v1/issues")
      .length,
    2,
  );
});

test("full poll separates app/search #42, assigned seed, source activity and head updates across restart", async () => {
  const {
    isNotifiableReview,
    mapWithConcurrency,
    recentlyUpdatedPrs,
    reviewActivity,
  } = await import("./github-pr-activity.mjs");
  const h = harness();
  const repos = ["example/app", repository];
  h.github.config.reviewRepositories = repos;
  h.github.config.notifyPrComments = true;
  h.github.config.includePullRequests = true;
  h.github.config.cursorTs = "";
  h.github.config.seenIds = [];
  h.github.config.limit = 1;
  h.github.config.prCommentCursorTs = "2026-10-27T00:00:00Z";
  const stamp = new Date().toISOString();
  const heads = { "example/app": "c".repeat(40), [repository]: headA };
  Object.assign(h.context, {
    isNotifiableReview,
    mapWithConcurrency,
    recentlyUpdatedPrs,
    reviewActivity,
  });
  vm.runInContext(
    ["githubRelatedPrs", "githubPrComments", "githubPrReviews"]
      .map(functionSource)
      .join("\n"),
    h.context,
  );
  const activity = [];
  const runRules = h.context.runRules;
  h.context.runRules = async (event) => {
    if (event.type === "pr_comment") activity.push(event);
    return runRules(event);
  };
  h.context.fetch = async (input) => {
    const url = new URL(input);
    const repo =
      url.pathname === "/search/issues"
        ? url.searchParams.get("q").match(/^repo:([^ ]+)/)[1]
        : url.pathname.split("/").slice(2, 4).join("/");
    assert.ok(repos.includes(repo));
    const item = {
      ...fixture.searchItem,
      repository_url: `https://api.github.com/repos/${repo}`,
      html_url: `https://github.com/${repo}/pull/42`,
      updated_at: stamp,
    };
    if (url.pathname === "/search/issues")
      return {
        ok: true,
        json: async () => ({
          total_count: 1,
          incomplete_results: false,
          items: [item],
        }),
      };
    if (url.pathname.endsWith("/pulls/42"))
      return {
        ok: true,
        json: async () => ({
          ...fixture.details,
          head: { ...fixture.details.head, sha: heads[repo] },
        }),
      };
    let rows = [];
    if (url.pathname.endsWith("/issues")) {
      assert.equal(repo, "example/app");
      assert.equal(url.searchParams.get("assignee"), fixture.login);
      rows =
        url.searchParams.get("page") === "1"
          ? [
              {
                id: 991,
                number: 991,
                title: "assigned seed only",
                updated_at: stamp,
              },
            ]
          : url.searchParams.get("page") === "2"
            ? [item]
            : [];
    } else if (url.pathname.endsWith("/issues/comments"))
      rows = [
        {
          id: 1,
          issue_url: `https://api.github.com/repos/${repo}/issues/42`,
          url: `https://api.github.com/repos/${repo}/issues/comments/1`,
          html_url: `https://github.com/${repo}/pull/42#issuecomment-1`,
          user: { login: "other" },
          body: "comment",
          created_at: stamp,
        },
      ];
    else if (url.pathname.endsWith("/reviews"))
      rows = [
        {
          id: 2,
          state: "APPROVED",
          body: "review body",
          submitted_at: stamp,
          user: { login: "other" },
          url: `https://api.github.com/repos/${repo}/pulls/42/reviews/2`,
          html_url: `https://github.com/${repo}/pull/42#pullrequestreview-2`,
        },
      ];
    return { ok: true, text: async () => JSON.stringify(rows) };
  };
  await h.context.pollGithub(h.github);
  assert.equal(h.store.issues.size, 2);
  assert.ok(h.github.config.seenNumbers.includes("991"));
  assert.equal(h.events.filter((event) => event.type === "issue").length, 0);
  h.github.config = JSON.parse(JSON.stringify(h.github.config));
  await h.context.pollGithub(h.github);
  await h.context.pollGithub(h.github);
  assert.equal(h.store.issues.size, 2);
  assert.equal(h.store.tags.size, 2);
  assert.equal(activity.length, 4);
  assert.ok(activity.every((event) => event.url.includes(`/${event.repo}/`)));
  const mapped = h.target.config.issueMap;
  assert.notEqual(mapped["example/app#42"], mapped[`${repository}#42`]);
  assert.equal(
    h.store.issues.get(mapped["example/app#42"]).extension_metadata
      .github_head_sha,
    heads["example/app"],
  );
  heads[repository] = headB;
  await h.context.pollGithub(h.github);
  assert.equal(h.store.issues.size, 2);
  assert.equal(
    h.store.issues.get(mapped[`${repository}#42`]).extension_metadata
      .github_head_sha,
    headB,
  );
  const updates = h.events.filter((event) => event.type === "pr_updated");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].repo, repository);
});

test("one pending import retry does not hold a new rule destination behind its backoff", async () => {
  const h = harness({ failTag: true });
  await h.poll();
  assert.equal(h.state.retryQueue.length, 1);
  h.options.failTag = false;
  h.state.connectors.push({
    id: "second",
    type: "vibe_kanban",
    enabled: true,
    config: {
      projectId: "second-project",
      baseUrl: "https://second.invalid",
      statusId: "todo",
    },
  });
  h.state.rules.push({
    id: "second-import",
    enabled: true,
    script: script.replaceAll("vibe-default", "second"),
  });
  const result = await h.poll();
  assert.equal(h.store.issues.size, 2);
  assert.equal(result.open[0].targets.length, 2);
  assert.equal(result.missing.length, 1);
  assert.equal(h.state.retryQueue.length, 1);
  await h.context.processRetryQueue({ force: true });
  assert.equal((await h.poll()).missing.length, 0);
});

test("tag cache entries are scoped to each project, including legacy cache migration", async () => {
  const h = harness();
  h.target.config.tagMap = { review: "old-project-tag" };
  const reads = [];
  h.context.vibeApi = async (_, method, endpoint) => {
    assert.equal(method, "GET");
    reads.push(endpoint);
    const project = new URLSearchParams(endpoint.split("?")[1]).get(
      "project_id",
    );
    return { tags: [{ id: `${project}-tag`, name: "review" }] };
  };
  vm.runInContext(functionSource("resolveVibeTag"), h.context);
  assert.equal(
    await h.context.resolveVibeTag(h.target, "project-target", "review"),
    "project-target-tag",
  );
  assert.equal(
    await h.context.resolveVibeTag(h.target, "second-project", "review"),
    "second-project-tag",
  );
  assert.equal(
    await h.context.resolveVibeTag(h.target, "project-target", "review"),
    "project-target-tag",
  );
  assert.equal(reads.length, 2);
});

test("review imports ignore ordinary issue seed, backfill and legacy seen IDs during full polling", async () => {
  for (const config of [
    { cursorTs: "", seenIds: [], backfill: false },
    { cursorTs: "", seenIds: [], backfill: true },
    {
      cursorTs: "2026-10-28T00:00:00Z",
      seenIds: [String(fixture.searchItem.id)],
      backfill: false,
    },
  ]) {
    const h = harness();
    Object.assign(h.github.config, config);
    await h.context.pollGithub(h.github);
    await h.context.pollGithub(h.github);
    const reviews = [...h.store.issues.values()].filter(
      (issue) => issue.extension_metadata.github_pr_number === 42,
    );
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].extension_metadata.github_repository, repository);
    assert.equal(h.github.config.reviewPrReconciliation.missing.length, 0);
  }
});

test("a failed second destination stays visibly missing even when the first destination is ready", async () => {
  const h = harness({ failTarget: "second" });
  await h.poll();
  h.state.connectors.push({
    id: "second",
    type: "vibe_kanban",
    enabled: true,
    config: {
      projectId: "second-project",
      baseUrl: "https://second.invalid",
      statusId: "todo",
    },
  });
  h.state.rules.push({
    id: "second-import",
    enabled: true,
    script: script.replaceAll("vibe-default", "second"),
  });
  let result = await h.poll();
  assert.equal(h.store.issues.size, 1);
  assert.equal(result.missing.length, 1);
  assert.equal(result.open[0].status, "retry_pending");
  const attempts = h.requests.filter((r) => r.target === "second").length;
  await h.poll();
  assert.equal(
    h.requests.filter((r) => r.target === "second").length,
    attempts,
  );
  h.options.failTarget = null;
  await h.context.processRetryQueue({ force: true });
  result = await h.poll();
  assert.equal(h.store.issues.size, 2);
  assert.equal(result.open[0].targets.length, 2);
  assert.equal(result.missing.length, 0);
});

test("a deleted cached review tag is refreshed after a failed attachment instead of remaining stuck", async () => {
  const h = harness();
  h.target.config.tagMap = { "project-target:review": "deleted-tag" };
  const api = h.context.vibeApi;
  h.context.vibeApi = async (connector, method, endpoint, ...args) => {
    if (endpoint.startsWith("/v1/tags?"))
      return { tags: [{ id: "review-tag", name: "review" }] };
    return api(connector, method, endpoint, ...args);
  };
  h.context.attachVibeTag = async (_, id, tag) => {
    if (tag === "deleted-tag")
      throw Object.assign(new Error("foreign key violation"), { status: 500 });
    h.store.tags.add(id);
  };
  vm.runInContext(functionSource("resolveVibeTag"), h.context);
  await h.poll();
  await h.context.processRetryQueue({ force: true });
  const result = await h.poll();
  assert.equal(h.target.config.tagMap["project-target:review"], "review-tag");
  assert.equal(h.store.issues.size, 1);
  assert.equal(h.store.tags.size, 1);
  assert.equal(result.missing.length, 0);
});

test("activity searches bound historical PRs while request discovery remains cursor-independent", async () => {
  const h = harness();
  const queries = [];
  h.context.fetch = async (input) => {
    const url = new URL(input);
    const q = url.searchParams.get("q");
    queries.push(q);
    return {
      ok: true,
      json: async () => ({
        total_count: q.includes("updated:>=2026-10-28") ? 1 : 2000,
        items: [fixture.searchItem],
      }),
    };
  };
  vm.runInContext(functionSource("githubRelatedPrs"), h.context);
  const related = await h.context.githubRelatedPrs(
    h.github,
    fixture.login,
    repository,
    "2026-10-28T01:00:00Z",
  );
  assert.equal(related.length, 1);
  assert.equal(queries.length, 4);
  assert.ok(
    queries.every(
      (q) =>
        q.startsWith(`repo:${repository} is:pr `) &&
        q.includes("updated:>=2026-10-28"),
    ),
  );
  const fresh = harness();
  const fetch = fresh.context.fetch;
  fresh.context.fetch = async (input, options) => {
    if (new URL(input).pathname === "/search/issues")
      assert.equal(
        new URL(input).searchParams.get("q").includes("updated:"),
        false,
      );
    return fetch(input, options);
  };
  await fresh.poll();
  assert.equal(fresh.store.issues.size, 1);
});
