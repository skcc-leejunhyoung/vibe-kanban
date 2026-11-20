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
  shouldReconcileGithubIssues,
  runSingleFlight,
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

function connectorSettings(h) {
  Object.assign(h.context, { githubLoginCache: new Map() });
  vm.runInContext([
    source.slice(source.indexOf('const RUNTIME_CONFIG_KEYS'), source.indexOf('// Deep copy of state')),
    ...[
      "applyConnectorPatch", "upsertConnector", "preserveGithubActivityConfig",
      "preserveMissingRuntimeConfig", "preserveMaskedSecrets", "githubApiBase", "fetchGithubAccount",
      "moveGithubActivityRepository", "fetchGithubRepository",
    ].map(functionSource),
  ].join("\n"), h.context);
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
  "githubApiBase",
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
  "startGithubIssueSync",
  "pollGithubPrComments",
  "pollGithubRepositoryPrComments",
  "githubDiscoverActivityPrs",
  "githubOldestScopedActivityCursor",
  "pollGithubAutomaticPrActivity",
  "githubLegacyPrActivityKey",
  "githubPrActivityKey",
  "githubScopedActivityState",
  "emitGithubPrActivity",
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
    reviewNotifications: [],
  };
  const context = vm.createContext({
    vm,
    randomUUID,
    // Own-PR CI/conflict polling has its own tests (github-pr-activity.test.mjs).
    pollGithubPrHealth: async () => {},
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
    GITHUB_ACTIVITY_OVERLAP_MS: 5 * 60 * 1000,
    githubIssuePollSince,
    selectGithubPollCandidates,
    selectGithubImportCandidates,
    markGithubIssueSeen,
    shouldReconcileGithubIssues,
    githubIssueSyncLastRunAt: new Map(),
    githubIssueSyncInFlight: new Map(),
    runSingleFlight,
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
    persistState: async (_, update) => {
      if (update) Object.assign(update.config, update.values);
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
    // Remote (issue_tags.rs): attaching `review` notifies only an issue in "To do".
    attachVibeTag: async (_, id) => {
      if (store.issues.get(id)?.status_id === "todo") h.reviewNotifications.push(id);
      store.tags.add(id);
    },
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
        // Remote (issues.rs sync_status_from_pull_request): an open PR moves an
        // issue to "In review" unless it already carries the review tag.
        const linked = store.issues.get(payload.issue_id);
        if (linked && payload.status === "open" && !store.tags.has(payload.issue_id))
          linked.status_id = "in-review";
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

test("a new review PR is tagged before its PR link so it stays To do and notifies once", async () => {
  const h = harness();
  const result = await h.poll();
  assert.equal(result.open[0].status, "tracked");
  const [[id, issue]] = [...h.store.issues];
  assert.equal(h.store.links.length, 1);
  assert.ok(h.store.tags.has(id));
  assert.equal(issue.status_id, "todo"); // not moved to In review before a review workspace exists
  assert.deepEqual(h.reviewNotifications, [id]);
  await h.poll(); // reconciliation repairs nothing and does not notify again
  assert.deepEqual(h.reviewNotifications, [id]);
});

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
  // The review tag goes first (it only notifies an issue still in "To do"); a
  // failed link leaves the PR missing, so the next poll restores the link.
  assert.equal(h.store.tags.size, 1);
  assert.equal(h.store.links.length, 0);
  assert.equal(h.reviewNotifications.length, 1);
  h.options.failLink = false;
  const resumed = harness({ state: structuredClone(h.state), store: h.store });
  await resumed.context.processRetryQueue({ force: true });
  result = await resumed.poll();
  assert.equal(result.missing.length, 0);
  assert.equal(resumed.store.issues.size, 1);
  assert.equal(resumed.store.links.length, 1);
  assert.equal(resumed.reviewNotifications.length, 0); // tagged already: no second notification
  assert.equal([...resumed.store.issues.values()][0].status_id, "todo");
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
  const notifications = [];
  h.state.rules.push({
    id: "notify",
    enabled: true,
    script: vm.runInNewContext(
      source.match(/const defaultGithubPrCommentRuleScript = (`[^]*?`);/)[1],
    ),
  });
  vm.runInContext(
    functionSource("createVibePullRequestCommentNotification"),
    h.context,
  );
  const vibeApi = h.context.vibeApi;
  h.context.vibeApi = async (connector, method, endpoint, body) => {
    if (endpoint === "/v1/notifications/pull-request-comment") {
      assert.equal(method, "POST");
      notifications.push(body);
      return {};
    }
    return vibeApi(connector, method, endpoint, body);
  };
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
          state: repo === "example/app" ? "APPROVED" : "CHANGES_REQUESTED",
          body: repo === "example/app" ? "" : " \n\t",
          submitted_at: stamp,
          user: { login: "other" },
          url: `https://api.github.com/repos/${repo}/pulls/42/reviews/2`,
          html_url: `https://github.com/${repo}/pull/42#pullrequestreview-2`,
        },
        {
          id: 3,
          state: "COMMENTED",
          body: "",
          submitted_at: stamp,
          user: { login: "other" },
          url: `https://api.github.com/repos/${repo}/pulls/42/reviews/3`,
        },
      ];
    else if (url.pathname.endsWith("/pulls/comments"))
      rows = [
        {
          id: 4,
          pull_request_url: `https://api.github.com/repos/${repo}/pulls/42`,
          url: `https://api.github.com/repos/${repo}/pulls/comments/4`,
          html_url: `https://github.com/${repo}/pull/42#discussion_r4`,
          user: { login: "other" },
          body: "inline comment",
          created_at: stamp,
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
  assert.equal(activity.length, 6);
  assert.equal(notifications.length, 6);
  for (const [repo, state, preview] of [
    ["example/app", "approved", "승인 (본문 없음)"],
    [repository, "changes_requested", "변경 요청 (본문 없음)"],
  ]) {
    const reviews = activity.filter(
      (event) => event.repo === repo && event.reviewState,
    );
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].reviewState, state);
    assert.equal(reviews[0].body, preview);
    assert.equal(
      notifications.filter((body) => body.comment_preview === preview).length,
      1,
    );
  }
  assert.equal(
    notifications.filter((body) => body.comment_preview === "inline comment")
      .length,
    2,
  );
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
  assert.equal(activity.length, 6);
  assert.equal(notifications.length, 6);
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

test("automatic activity discovers current repositories, retries partial reads and delivers new reviews once", async () => {
  const h = harness();
  Object.assign(h.context, await import("./github-pr-activity.mjs"));
  vm.runInContext(
    ["githubPrComments", "githubPrReviews"].map(functionSource).join("\n"),
    h.context,
  );
  delete h.github.config.reviewRepositories;
  h.github.config.notifyPrComments = true;
  const cursor = new Date(Date.now() - 30_000).toISOString();
  const stamp = new Date(Date.now() - 10_000).toISOString();
  const lateIndexed = new Date(Date.parse(cursor) - 30_000).toISOString();
  h.github.config.prCommentCursors = {
    "example/app": { cursorTs: cursor, seenIds: [
      "https://github.com/example/app/pull/42#pullrequestreview-4:4",
    ] },
  };
  const app = "moved/product";
  const another = "another/service";
  const item = (repo) => ({
    ...fixture.searchItem,
    repository_url: `https://api.github.com/repos/${repo}`,
    html_url: `https://github.com/${repo}/pull/42`,
  });
  const json = (data) => ({
    ok: true,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  let unavailable = true;
  let newReview = false;
  let retryReads = 0;
  const events = [];
  h.context.runRules = async (event) => events.push(event);
  h.context.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/search/issues") {
      const q = url.searchParams.get("q");
      assert.ok(!q.includes("repo:"), q);
      assert.match(q, /^is:pr is:(open|closed) (review-)?involves:/);
      const items = q.includes("is:closed") ? [] : q.includes("review-involves:") && unavailable
        ? [item(app), item(another)] : [item(app)];
      return json({ total_count: items.length, incomplete_results: false, items });
    }
    assert.match(url.pathname, /^\/repos\/(moved\/product|another\/service)\/(issues|pulls)\/42\/(comments|reviews)$/);
    if (url.pathname.includes(another)) {
      retryReads += 1;
      if (unavailable) return { ok: false, status: 503, text: async () => "fixture" };
      if (!url.pathname.endsWith("/reviews")) return json([]);
      return json([{ id: 7, user: { login: "synthetic-reviewer" },
        state: "APPROVED", submitted_at: stamp, commit_id: headA }]);
    }
    const reviewer = { login: "synthetic-reviewer" };
    if (url.pathname.endsWith("/reviews"))
      return json([4, 5, ...(newReview ? [6] : [])].map((id) => ({
        id, user: reviewer, state: "CHANGES_REQUESTED", submitted_at: id === 6 ? stamp : lateIndexed,
        commit_id: headA, html_url: `${item(app).html_url}#pullrequestreview-${id}`,
      })));
    if (url.pathname.includes("/issues/"))
      return json([{ id: 5, user: reviewer, created_at: stamp,
        html_url: `${item(app).html_url}#issuecomment-5`, body: "fixture comment" }]);
    return json([]);
  };
  const poll = () => h.context.pollGithubPrComments(h.github, fixture.login);
  assert.equal((await poll()).processed, 2);
  const runtime = h.github.config.prActivityDiscovery;
  assert.equal(runtime.cursorTs, cursor);
  assert.equal(runtime.complete, false);
  assert.equal(runtime.repositories.length, 1);
  assert.equal(runtime.repositories[0].repository, app);
  assert.equal(h.github.config.prCommentErrors[0].repository, another);
  assert.deepEqual(events.map((event) => [event.repo, event.reviewState, event.raw.id]), [
    [app, "changes_requested", 5], [app, null, 5],
  ]);
  assert.equal(runtime.pendingPrs.length, 1);
  assert.equal(runtime.pendingPrs[0].repository, another);
  h.github.config.prActivityDiscovery = JSON.parse(JSON.stringify(runtime));
  unavailable = false;
  newReview = true;
  assert.equal((await poll()).processed, 2);
  assert.deepEqual(events.slice(2).map((event) => event.raw.id).sort(), [6, 7]);
  const recovered = h.github.config.prActivityDiscovery;
  assert.equal(recovered.complete, true);
  assert.ok(recovered.cursorTs > cursor);
  assert.equal(recovered.repositories.length, 2);
  assert.equal(recovered.pendingPrs.length, 0);
  const readsAfterRecovery = retryReads;
  assert.equal((await poll()).processed, 0);
  assert.equal(retryReads, readsAfterRecovery);
  assert.equal(h.store.issues.size, 0);
});

test("automatic activities keep their cursor on incomplete global discovery", async () => {
  const h = harness();
  Object.assign(h.context, await import("./github-pr-activity.mjs"));
  delete h.github.config.reviewRepositories;
  h.github.config.notifyPrComments = true;
  let searchCalls = 0;
  h.context.fetch = async (input) => {
    const url = new URL(input);
    searchCalls += 1;
    assert.equal(url.pathname, "/search/issues");
    return { ok: false, status: 403 };
  };
  const result = await h.context.pollGithubPrComments(h.github, fixture.login);
  assert.equal(searchCalls, 4);
  assert.equal(result.errors.length, 4);
  assert.equal(result.errors[0].repository, "GitHub discovery");
  assert.equal(h.github.config.prActivityDiscovery.complete, false);
  assert.equal(h.github.config.prActivityDiscovery.cursorTs, h.github.config.prActivityDiscovery.startedAt);
  assert.equal(h.github.config.prActivityDiscovery.repositories.length, 0);
});

test("automatic activity skips unchanged open PRs and reuses comment URLs within one window", async () => {
  const h = harness();
  Object.assign(h.context, await import("./github-pr-activity.mjs"));
  vm.runInContext(["githubPrComments", "githubPrReviews"].map(functionSource).join("\n"), h.context);
  let now = Date.parse("2002-03-06T00:32:00Z");
  h.context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
  };
  Object.assign(h.github.config, {
    notifyPrComments: true, reviewRepositories: [],
    prCommentCursorTs: "2002-03-06T00:31:00Z",
  });
  const unchanged = Array.from({ length: 50 }, (_, index) => ({
    ...fixture.searchItem, number: index + 100,
    created_at: "2002-03-05T00:00:00Z", updated_at: "2002-03-05T00:00:00Z",
  }));
  const active = { ...fixture.searchItem, updated_at: "2002-03-06T00:31:50Z" };
  const reads = [];
  h.context.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q");
      const match = / (updated|created):([^ ]+)\.\.([^ ]+)$/.exec(query);
      assert.ok(match, query);
      const [, field, since, until] = match;
      const items = query.includes("is:closed") || query.includes("review-involves:") ? [] :
        [...unchanged, active].filter((row) =>
          Date.parse(row[`${field}_at`]) >= Date.parse(since) &&
          Date.parse(row[`${field}_at`]) <= Date.parse(until));
      return Response.json({ total_count: items.length, items });
    }
    reads.push(url);
    return Response.json([]);
  };
  for (let index = 0; index < 2; index++) {
    assert.equal((await h.context.pollGithubPrComments(h.github, fixture.login)).errors.length, 0);
    now += 60_000;
  }
  assert.equal(reads.length, 6);
  assert.ok(reads.every(({ pathname }) => pathname.includes(`/${active.number}/`)));
  assert.deepEqual(reads.slice(0, 3).map(String).sort(), reads.slice(3).map(String).sort());
});

test("retains PRs already found when a later activity search fails", async () => {
  const h = harness();
  Object.assign(h.context, await import("./github-pr-activity.mjs"));
  delete h.github.config.reviewRepositories;
  h.github.config.notifyPrComments = true;
  const extraPr = { ...fixture.searchItem, number: fixture.searchItem.number + 1 };
  let firstPoll = true;
  h.context.fetch = async (input) => {
    const query = new URL(input).searchParams.get("q");
    if (firstPoll && query.includes("is:closed involves:")) return { ok: false, status: 503 };
    const items = !firstPoll || !query.includes("is:open") ? []
      : query.includes("review-involves:") ? [extraPr] : [fixture.searchItem];
    return { ok: true, json: async () => ({ total_count: items.length, items }) };
  };
  let reads = 0;
  h.context.githubPrComments = async (_, since, repository, number) => {
    reads += 1;
    if (firstPoll && number === fixture.searchItem.number) throw new Error("fixture comment 503");
    return [];
  };
  const poll = () => h.context.pollGithubPrComments(h.github, fixture.login);
  const first = await poll();
  assert.equal(first.errors.length, 2);
  assert.equal(reads, 2);
  assert.equal(first.errors[0].state, "closed");
  assert.equal(first.errors[0].qualifier, "involves");
  const saved = JSON.parse(JSON.stringify(h.persisted.connectors[0].config.prActivityDiscovery));
  assert.equal(saved.complete, false);
  assert.equal(saved.pendingPrs[0].number, fixture.searchItem.number);
  h.github.config.prActivityDiscovery = saved;
  firstPoll = false;
  assert.equal((await poll()).errors.length, 0);
  assert.equal(reads, 3);
  assert.equal(h.github.config.prActivityDiscovery.complete, true);
  assert.equal(h.github.config.prActivityDiscovery.pendingPrs.length, 0);
});

test("publishes activity receipts only after a durable write and retains recovery state when a write fails", async () => {
  const h = harness();
  delete h.github.config.reviewRepositories;
  h.github.config.notifyPrComments = true;
  const cursor = new Date(Date.now() - 30_000).toISOString();
  h.github.config.prCommentCursorTs = cursor;
  h.context.fetch = async () => ({
    ok: true,
    json: async () => ({ total_count: 1, items: [fixture.searchItem] }),
  });
  const events = [];
  h.context.runRules = async (event) => events.push(event);
  h.context.githubPrComments = async () => [{
    id: 123, user: { login: "fixture-author" }, created_at: cursor,
  }];
  let pauseWrite;
  let renameStarted;
  const waitForRename = new Promise((resolve) => { renameStarted = resolve; });
  const writes = [];
  let contents;
  let fail = true;
  Object.assign(h.context, await import("./github-pr-activity.mjs"), {
    STATE_PATH: "/fixture/state.json", AUTOPILOT_OBSERVATIONS_PATH: "/fixture/observations.json", AUTOPILOT_TRIAGE_PATH: "/fixture/triage.json",
    writeQueue: Promise.resolve(), githubActivityWrites: new Set(),
    process: { pid: 9 }, console: { error() {} },
    fs: {
      async writeFile(_path, data) {
        if (fail) throw new Error("fixture write error");
        contents = data;
      },
      async rename() {
        if (!writes.length) await new Promise((resolve) => {
          pauseWrite = resolve;
          renameStarted();
        });
        writes.push(JSON.parse(contents));
      },
    },
  });
  vm.runInContext(
    ["persistState", "enqueueWrite"].map(functionSource).join("\n"),
    h.context,
  );
  const poll = () => h.context.pollGithubPrComments(h.github, fixture.login);
  await assert.rejects(poll(), /fixture write error/);
  assert.equal(h.github.config.prActivityDiscovery.complete, false);
  assert.equal(h.github.config.prActivityDiscovery.cursorTs, cursor);
  assert.equal(h.github.config.prActivityDiscovery.repositories.length, 0);
  assert.equal(h.github.config.prCommentErrors[0].repository, "GitHub persistence");
  assert.equal(writes.length, 0);
  fail = false;
  const retry = poll();
  await waitForRename;
  assert.equal(h.github.config.prActivityDiscovery.complete, false);
  h.state.enabled = false;
  const concurrentWrite = h.context.persistState();
  h.state.enabled = true;
  pauseWrite();
  await Promise.all([retry, concurrentWrite]);
  assert.equal(events.length, 1);
  assert.equal(writes.length, 2);
  assert.equal(h.github.config.prActivityDiscovery.complete, true);
  assert.equal(writes.at(-1).connectors[0].config.prActivityDiscovery.complete, true);
  assert.equal(writes.at(-1).enabled, false);
});

test("connector settings saved during a poll inherit the new receipt without replaying events", async (t) => {
  for (const method of ["POST", "PATCH"]) await t.test(method, async (subtest) => {
    const h = harness();
    delete h.github.config.reviewRepositories;
    h.github.config.notifyPrComments = true;
    const cursor = new Date(Date.now() - 30_000).toISOString();
    const previous = { startedAt: cursor, cursorTs: cursor, checkedAt: cursor, seen: {} };
    h.github.config.prActivityDiscovery = previous;
    const stale = { ...h.github.config, token: "__stored__", intervalSeconds: 120 };
    const events = [];
    let saveStarted;
    let releaseSave;
    const writing = new Promise((resolve) => { saveStarted = resolve; });
    const held = new Promise((resolve) => { releaseSave = resolve; });
    subtest.after(releaseSave);
    let first = true;
    Object.assign(h.context, await import("./github-pr-activity.mjs"), {
      pollInFlight: new Map(), connectorSaves: new Map(),
      fetch: async () => ({
        ok: true,
        json: async () => ({ total_count: 1, items: [fixture.searchItem] }),
      }),
      runRules: async (event) => events.push(event),
      githubPrComments: async () => [{
        id: 123, user: { login: "fixture-author" }, created_at: cursor,
      }],
      persistState: async (_, update) => {
        if (update && first) {
          first = false;
          saveStarted();
          await held;
        }
        if (update) Object.assign(update.config, update.values);
        h.persisted = structuredClone(h.state);
      },
    });
    h.context.runPoll = async (id) => id === h.github.id
      ? h.context.pollGithubPrComments(h.context.findConnector(id), fixture.login)
      : { ok: true };
    connectorSettings(h);
    vm.runInContext(["saveConnectorAfterPoll", "pollConnector", "withIssueSyncResult"]
      .map(functionSource).join("\n"), h.context);
    const id = h.github.id;
    const firstPoll = h.context.pollConnector(id, false);
    await writing;
    const save = h.context.saveConnectorAfterPoll(id, () => method === "POST"
      ? h.context.upsertConnector({ ...h.github, config: stale })
      : h.context.applyConnectorPatch(h.github, { config: stale }));
    const manual = h.context.pollConnector(id, true);
    assert.equal((await h.context.pollConnector(id, false)).skipped, "in-flight");
    assert.equal((await h.context.pollConnector("other", false)).ok, true);
    assert.equal(h.context.findConnector(id).config.intervalSeconds, undefined);
    releaseSave();
    await Promise.all([firstPoll, save, manual]);
    const current = h.context.findConnector(id);
    assert.equal(current.config.intervalSeconds, 120);
    assert.equal(current.config.token, "synthetic");
    assert.ok(current.config.prActivityDiscovery.checkedAt > previous.checkedAt);
    assert.equal(current.config.prActivityDiscovery.seen["issue:123"], cursor);
    assert.equal(h.persisted.connectors[0].config.prActivityDiscovery.seen["issue:123"], cursor);
    assert.equal(events.length, 1);

    const receipt = current.config.prActivityDiscovery;
    await h.context.applyConnectorPatch(current, { config: { ...current.config, prActivityDiscovery: null } });
    assert.equal(current.config.prActivityDiscovery, null);
    h.context.githubLoginCache.set(id, fixture.login);
    h.context.fetch = async (url, { headers }) => {
      assert.equal(url, "https://api.github.com/user");
      const accountId = headers.authorization === "Bearer synthetic" ? 11 : 12;
      return { ok: true, json: async () => ({ id: accountId, login: "fixture-login" }) };
    };
    await h.context.applyConnectorPatch(current, {
      config: { ...current.config, token: "fixture-other-token", prActivityDiscovery: receipt },
    });
    assert.equal(current.config.prActivityDiscovery, undefined);
    assert.equal(h.context.githubLoginCache.has(id), false);
  });
});

test("saving stale settings preserves scoped GitHub cursors and avoids redelivery", async (t) => {
  for (const method of ["POST", "PATCH"]) await t.test(method, async () => {
    const h = harness();
    connectorSettings(h);
    const config = h.github.config;
    config.notifyPrComments = true;
    config.prCommentCursors = { [repository]: { cursorTs: new Date(Date.now() - 30_000).toISOString(), seenIds: [] } };
    const stale = structuredClone(config);
    const comment = { id: 31, url: "https://fixture.invalid/comment/31",
      issue_url: `https://fixture.invalid/issues/${pr.number}`, user: { login: "fixture-author" } };
    const emitted = [];
    Object.assign(h.context, {
      githubRelatedPrs: async () => [pr], githubPrComments: async () => [comment],
      runRules: async (event) => emitted.push(event.raw.id),
    });
    const poll = () => h.context.pollGithubRepositoryPrComments(h.state.connectors[0], fixture.login, repository);
    await poll();
    const cursor = config.prCommentCursors[repository].cursorTs;
    stale.intervalSeconds = 120;
    if (method === "POST") await h.context.upsertConnector({ ...h.github, config: stale });
    else await h.context.applyConnectorPatch(h.github, { config: stale });
    assert.equal(h.state.connectors[0].config.intervalSeconds, 120);
    assert.equal(h.state.connectors[0].config.prCommentCursors[repository].cursorTs, cursor);
    await poll();
    assert.deepEqual(emitted, [comment.id]);
  });
});

test("token rotation keeps activity only for the verified GitHub account", async () => {
  const h = harness();
  connectorSettings(h);
  const receipt = { pendingPrs: [pr], cursorTs: "2025-01-01T00:00:00Z" };
  h.github.config.prActivityDiscovery = receipt;
  h.github.config.prCommentCursorTs = receipt.cursorTs;
  h.github.config.seenPrCommentIds = ["fixture"];
  let oldTokenActive = true;
  const tokens = [];
  h.context.fetch = async (url, { headers }) => {
    assert.equal(url, "https://api.github.com/user");
    const token = headers.authorization.slice("Bearer ".length);
    tokens.push(token);
    if (token === "synthetic" && !oldTokenActive) return { ok: false, status: 401 };
    const id = token === "fixture-other-account" ? 11 : 10;
    return { ok: true, json: async () => ({ id, login: "fixture-login" }) };
  };
  const patchToken = (token) => h.context.applyConnectorPatch(h.github, {
    name: "fixture settings", config: { ...h.github.config, token, githubActivityAccountId: 999 },
  });
  oldTokenActive = false;
  await assert.rejects(patchToken("fixture-rotation"), /Cannot verify the previous GitHub account/);
  assert.equal(h.github.config.token, "synthetic");
  assert.equal(h.github.name, undefined);
  oldTokenActive = true;
  await patchToken("fixture-rotation");
  assert.equal(h.github.config.prActivityDiscovery, receipt);
  assert.equal(h.github.config.githubActivityAccountId, 10);
  tokens.length = 0;
  h.state.connectors.unshift({ id: "fixture-deleted" });
  const save = h.context.upsertConnector({ ...h.github, config: { ...h.github.config, token: "fixture-next-rotation" } });
  h.state.connectors.shift();
  await save;
  assert.deepEqual(tokens, ["fixture-next-rotation"]);
  assert.deepEqual(h.state.connectors.map(({ id }) => id), [h.github.id, h.target.id]);
  assert.equal(h.state.connectors[0].config.token, "fixture-next-rotation");
  h.github = h.state.connectors[0];
  assert.equal(h.github.config.prActivityDiscovery, receipt);
  h.github.config.prActivityDiscovery = null;
  await patchToken("fixture-scoped-rotation");
  assert.equal(h.github.config.prActivityDiscovery, null);
  assert.equal(h.github.config.prCommentCursorTs, receipt.cursorTs);
  h.github.config.prActivityDiscovery = receipt;
  await patchToken("fixture-other-account");
  assert.equal(h.github.config.prActivityDiscovery, undefined);
  assert.equal(h.github.config.prCommentCursorTs, undefined);
  assert.equal(h.github.config.seenPrCommentIds, undefined);
});

test("a primary repository transfer preserves the activity window and retries at the verified new address", async (t) => {
  for (const verified of [true, false]) await t.test(verified ? "same repository ID" : "different repository ID", async () => {
    const h = harness();
    connectorSettings(h);
    Object.assign(h.context, await import("./github-pr-activity.mjs"));
    const oldRepo = "example/app";
    const newRepo = "example/moved";
    const cursor = new Date(Date.now() - 60_000).toISOString();
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    const pending = { ...pr, repository: oldRepo };
    const oldUrl = `https://github.com/${oldRepo}`;
    const newUrl = `https://github.com/${newRepo}`;
    Object.assign(h.github.config, {
      notifyPrComments: true, reviewRepositories: [],
      prCommentCursorTs: cursor, seenPrCommentIds: ["issue:91"],
      prActivityDiscovery: { cursorTs: cursor, startedAt: cursor, seen: {}, pendingPrs: [pending] },
    });
    h.context.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname === "/search/issues") return { ok: true, json: async () => ({ total_count: 0, items: [] }) };
      assert.ok([`/repos/${oldRepo}`, `/repos/${newRepo}`].includes(url.pathname));
      const isNew = url.pathname === `/repos/${newRepo}`;
      return { ok: true, json: async () => ({ id: isNew && !verified ? 16 : 15, html_url: isNew ? newUrl : oldUrl }) };
    };
    await h.context.applyConnectorPatch(h.github, { config: { ...h.github.config, repo: "moved" } });
    const config = h.github.config;
    const expectedRepo = verified ? newRepo : oldRepo;
    assert.equal(config.prActivityDiscovery.cursorTs, cursor);
    assert.deepEqual(Object.keys(config.prCommentCursors), [expectedRepo]);
    assert.equal(config.prCommentCursors[expectedRepo].cursorTs, cursor);
    assert.equal(config.prCommentCursorTs, undefined);
    assert.equal(config.prActivityDiscovery.pendingPrs[0].repository, expectedRepo);
    const events = [];
    h.context.runRules = async (event) => events.push(event);
    h.context.githubPrComments = async (_connector, since, source) => {
      assert.equal(since, cursor);
      assert.equal(source, expectedRepo);
      return [91, 92].map((id) => ({ id, created_at: createdAt, user: { login: "fixture-author" } }));
    };
    assert.equal((await h.context.pollGithubPrComments(h.github, fixture.login)).processed, 1);
    assert.deepEqual(events.map((event) => [event.repo, event.raw.id]), [[expectedRepo, 92]]);
    if (verified) assert.equal(events[0].pullRequestUrl, `${newUrl}/pull/${pr.number}`);
  });
});

test("switching between automatic and explicit scope does not replay a PR activity", async () => {
  const h = harness();
  connectorSettings(h);
  Object.assign(h.context, await import("./github-pr-activity.mjs"));
  const scopedRepo = `${h.github.config.owner}/${h.github.config.repo}`;
  const scopedPr = { ...pr, repository: scopedRepo };
  const cursor = new Date(Date.now() - 360_000).toISOString();
  Object.assign(h.github.config, {
    notifyPrComments: true, reviewRepositories: [],
    prCommentCursors: { [scopedRepo]: { cursorTs: cursor, seenIds: [] } },
  });
  const comment = (id, ago) => ({
    id, url: `https://api.github.com/repos/example/app/issues/comments/${id}`,
    issue_url: `https://api.github.com/repos/example/app/issues/${scopedPr.number}`,
    created_at: new Date(Date.now() - ago).toISOString(), user: { login: "fixture-author" },
  });
  const body = [comment(91, 330_000), comment(92, 25_000)];
  const emitted = [];
  Object.assign(h.context, {
    githubDiscoverActivityPrs: async (_, __, ___, ____, onPr) => { onPr(scopedPr); return []; },
    githubRelatedPrs: async () => [scopedPr], githubPrComments: async () => body,
    runRules: async ({ raw }) => emitted.push(raw.id),
  });
  const poll = () => h.context.pollGithubPrComments(h.github, fixture.login);
  const scope = (reviewRepositories) => h.context.applyConnectorPatch(h.github, {
    config: { ...h.github.config, reviewRepositories },
  });
  assert.equal((await poll()).processed, 2);
  assert.equal(h.github.config.prActivityDiscovery.seen["issue:91"], undefined);
  body.push(comment(93, 20_000));
  await scope([scopedRepo]);
  assert.equal((await poll()).processed, 1);
  assert.deepEqual(emitted, [91, 92, 93]);
  await scope([]);
  assert.equal((await poll()).processed, 0);
  assert.deepEqual(emitted, [91, 92, 93]);
});

test("explicit scope still reads the gap before the first automatic collection", async () => {
  const h = harness();
  const beforeAuto = new Date(Date.now() - 30 * 60_000).toISOString();
  const gapEventAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const autoStartedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  Object.assign(h.github.config, {
    notifyPrComments: true,
    prCommentCursors: { [repository]: { cursorTs: beforeAuto, seenIds: [] } },
    prActivityDiscovery: { startedAt: autoStartedAt, cursorTs: new Date().toISOString(), seen: {} },
  });
  const event = { id: 94, issue_url: `https://fixture.invalid/issues/${pr.number}`,
    created_at: gapEventAt, user: { login: "fixture-author" } };
  const emitted = [];
  Object.assign(h.context, {
    githubRelatedPrs: async () => [pr],
    githubPrComments: async (_, since) => Date.parse(since) <= Date.parse(gapEventAt) ? [event] : [],
    runRules: async ({ raw }) => emitted.push(raw.id),
  });
  await h.context.pollGithubRepositoryPrComments(h.github, fixture.login, repository);
  assert.deepEqual(emitted, [event.id]);
});

test("switching to automatic recovers the older cursor of an unavailable scoped repository", async (t) => {
  for (const previouslyAutomatic of [false, true]) {
    await t.test(`previously automatic: ${previouslyAutomatic}`, async () => {
      const h = harness();
      connectorSettings(h);
      Object.assign(h.context, await import("./github-pr-activity.mjs"));
      const time = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
      const oldCursor = time(40);
      const eventAt = time(35);
      Object.assign(h.github.config, {
        notifyPrComments: true,
        prCommentCursors: {
          "example/app": { cursorTs: time(2), seenIds: [] },
          [repository]: { cursorTs: oldCursor, seenIds: [] },
        },
        prActivityDiscovery: previouslyAutomatic
          ? { startedAt: time(20), cursorTs: time(10), seen: {} }
          : undefined,
      });
      const emitted = [];
      let unavailable = true;
      Object.assign(h.context, {
        githubRelatedPrs: async (_, __, repo) => repo === repository ? [pr] : [],
        githubDiscoverActivityPrs: async (_, __, since, ____, onPr) => {
          assert.ok(since <= eventAt);
          onPr(pr);
          return [];
        },
        githubPrComments: async (_, since, repo) => {
          if (repo !== repository) return [];
          if (unavailable) throw new Error("fixture GitHub 503");
          return eventAt >= since ? [{ id: 304, created_at: eventAt, user: { login: "fixture-author" } }] : [];
        },
        runRules: async ({ raw }) => emitted.push(raw.id),
      });
      const poll = () => h.context.pollGithubPrComments(h.github, fixture.login);
      assert.equal((await poll()).errors.length, 1);
      assert.equal(h.github.config.prCommentCursors[repository].cursorTs, oldCursor);
      unavailable = false;
      await h.context.applyConnectorPatch(h.github, { config: { ...h.github.config, reviewRepositories: [] } });
      assert.equal((await poll()).processed, 1);
      assert.equal(h.github.config.prActivityDiscovery.complete, true);
      assert.deepEqual(emitted, [304]);
    });
  }
});

test("a new scoped repository ignores comments from before the automatic connection even if edited later", async () => {
  const h = harness();
  const start = new Date(Date.now() - 60_000).toISOString();
  const old = new Date(Date.parse(start) - 60_000).toISOString();
  Object.assign(h.github.config, {
    notifyPrComments: true, prActivityDiscovery: { startedAt: start, cursorTs: start },
  });
  const comments = [old, start].map((created_at, index) => ({
    id: index + 300, issue_url: `https://fixture.invalid/issues/${pr.number}`,
    created_at, updated_at: start, user: { login: "fixture-author" },
  }));
  const emitted = [];
  Object.assign(h.context, {
    githubRelatedPrs: async () => [pr],
    githubPrComments: async (_, since, repo) => repo === repository ? comments.filter((row) => row.updated_at >= since) : [],
    runRules: async ({ raw }) => emitted.push(raw.id),
  });
  const poll = () => h.context.pollGithubPrComments(h.github, fixture.login);
  assert.equal((await poll()).processed, 1);
  assert.equal((await poll()).processed, 0);
  assert.deepEqual(emitted, [301]);
});

test("a newly scoped repository collects a comment never read by automatic discovery", async () => {
  const h = harness();
  Object.assign(h.context, await import("./github-pr-activity.mjs"));
  const time = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const first = { ...pr, repository: "example/app" };
  const event = {
    id: 95, issue_url: `https://fixture.invalid/issues/${pr.number}`, created_at: time(20),
    updated_at: time(1), user: { login: "fixture-author" },
  };
  Object.assign(h.github.config, {
    notifyPrComments: true, reviewRepositories: [],
    prActivityDiscovery: { startedAt: time(60), cursorTs: time(45), seen: {} },
  });
  const reads = [];
  const emitted = [];
  Object.assign(h.context, {
    githubDiscoverActivityPrs: async (_, __, ___, ____, onPr) => { onPr(first); return []; },
    githubRelatedPrs: async () => [pr],
    githubPrComments: async (_, since, selected) => {
      reads.push(selected);
      return selected === repository && event.updated_at >= since ? [event] : [];
    },
    runRules: async ({ raw }) => emitted.push(raw.id),
  });
  await h.context.pollGithubPrComments(h.github, fixture.login);
  assert.deepEqual(reads, [first.repository]);
  await h.context.pollGithubRepositoryPrComments(h.github, fixture.login, repository);
  assert.deepEqual(emitted, [event.id]);
});

test("explicit activity receipts survive restart and automatic replay after 2001 events", async () => {
  const h = harness();
  connectorSettings(h);
  Object.assign(h.context, await import("./github-pr-activity.mjs"));
  vm.runInContext(functionSource("maskState"), h.context);
  const time = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const result = Array.from({ length: 2001 }, (_, index) => ({
    id: index + 1, issue_url: `https://fixture.invalid/issues/${pr.number}`,
    created_at: time(20 - index / 200), user: { login: "fixture-author" },
  }));
  h.github.config.owner = "example";
  h.github.config.repo = "search";
  Object.assign(h.github.config, {
    notifyPrComments: true,
    prCommentCursors: { [repository]: { cursorTs: time(25), seenIds: [] } },
    prActivityDiscovery: { startedAt: time(60), cursorTs: time(45), seen: {} },
  });
  const emitted = [];
  Object.assign(h.context, {
    githubDiscoverActivityPrs: async (_, __, ___, ____, onPr) => { onPr(pr); return []; },
    githubRelatedPrs: async () => [pr], githubPrComments: async () => result,
    runRules: async ({ raw }) => emitted.push(raw.id),
  });
  const poll = () => h.context.pollGithubPrComments(h.github, fixture.login);
  assert.equal((await poll()).processed, 2001);
  h.github.config = structuredClone(h.persisted.connectors[0].config);
  assert.equal(h.github.config.prCommentCursors[repository].seenIds.length, 2001);
  const edited = h.context.maskState(h.state).connectors[0].config;
  assert.equal(edited.prCommentCursors[repository].seenIds, undefined);
  await h.context.applyConnectorPatch(h.github, { config: { ...edited, reviewRepositories: [] } });
  assert.equal((await poll()).processed, 0);
  assert.equal(emitted.length, 2001);
});

test("a scoped delivery failure keeps successful IDs without advancing past the failed event", async () => {
  const h = harness();
  const cursor = new Date(Date.now() - 60_000).toISOString();
  const events = [301, 302].map((id) => ({
    id, issue_url: `https://fixture.invalid/issues/${pr.number}`, created_at: cursor,
    user: { login: "fixture-author" },
  }));
  Object.assign(h.github.config, {
    owner: "example", repo: "search", notifyPrComments: true,
    prCommentCursors: { [repository]: { cursorTs: cursor, seenIds: [] } },
  });
  let fail = true;
  const emitted = [];
  Object.assign(h.context, {
    githubRelatedPrs: async () => [pr], githubPrComments: async () => events,
    runRules: async ({ raw }) => {
      if (fail && raw.id === 302) throw new Error("fixture delivery failed");
      emitted.push(raw.id);
    },
  });
  const poll = () => h.context.pollGithubPrComments(h.github, fixture.login);
  assert.equal((await poll()).errors.length, 1);
  h.github.config = structuredClone(h.persisted.connectors[0].config);
  assert.equal(h.github.config.prCommentCursors[repository].cursorTs, cursor);
  assert.deepEqual(h.github.config.prCommentCursors[repository].seenIds, ["issue:301"]);
  fail = false;
  assert.equal((await poll()).processed, 1);
  assert.deepEqual(emitted, [301, 302]);
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

test("a manual poll joining an interval run that skipped the issue sync polls again", async () => {
  const runs = [];
  const context = vm.createContext({
    pollInFlight: new Map(),
    connectorSaves: new Map(),
    runPoll: async (id, manual) => {
      runs.push(manual);
      await new Promise((resolve) => setImmediate(resolve));
      return {
        ok: true,
        issueSync: manual ? Promise.resolve({ synced: 3 }) : null,
      };
    },
  });
  vm.runInContext(functionSource("pollConnector"), context);
  vm.runInContext(functionSource("withIssueSyncResult"), context);
  const interval = context.pollConnector("github", false);
  const manual = context.pollConnector("github", true);
  const second = context.pollConnector("github", true);
  assert.equal((await interval).issueSync, null);
  assert.equal((await manual).linksSynced, 3);
  assert.equal((await second).linksSynced, 3);
  assert.equal("issueSync" in (await manual), false);
  assert.deepEqual(runs, [false, true]);
});

test("a manual poll waits for its issue sync outside the connector's poll slot", async () => {
  let release;
  const sync = new Promise((resolve) => (release = resolve));
  const runs = [];
  const context = vm.createContext({
    pollInFlight: new Map(),
    connectorSaves: new Map(),
    runPoll: async (id, manual) => {
      runs.push(manual);
      return { ok: true, issueSync: manual ? sync : null };
    },
  });
  vm.runInContext(functionSource("pollConnector"), context);
  vm.runInContext(functionSource("withIssueSyncResult"), context);
  let manualDone = false;
  const manual = context.pollConnector("github", true).then((result) => {
    manualDone = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  // The sync is still running, yet interval polls are no longer skipped.
  assert.equal(manualDone, false);
  assert.equal(context.pollInFlight.size, 0);
  assert.equal(
    (await context.pollConnector("github", false)).skipped,
    undefined,
  );
  release({ synced: 7, recovered: 1, backfilled: 2 });
  const result = await manual;
  assert.deepEqual(
    [result.linksSynced, result.linksRecovered, result.linksBackfilled],
    [7, 1, 2],
  );
  assert.deepEqual(runs, [true, false]);
});

test("issue-sync rounds read the board, leave the sync running, and a manual poll gets a fresh sync", async () => {
  const h = harness();
  h.state.rules.push({
    id: "sync",
    enabled: true,
    kind: "github_issue_sync",
    config: { githubConnectorId: h.github.id, githubProjectId: "project-1" },
  });
  h.context.pollGithubReviews = async () => ({ processed: 0 });
  h.context.runRules = async () => {};
  h.context.githubGraphql = async () => ({});
  let boardReads = 0;
  h.context.loadGithubProjectIssues = async () => {
    boardReads += 1;
    return [];
  };
  const releases = [];
  const gates = [0, 1].map(
    (i) => new Promise((resolve) => (releases[i] = resolve)),
  );
  let syncs = 0;
  h.context.reconcileGithubIssueRules = () => gates[syncs++];
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Due round: reads the board and starts the sync without waiting for it.
  assert.equal((await h.context.pollGithub(h.github)).issueSync, null);
  // Within the interval: neither the board nor the sync.
  await h.context.pollGithub(h.github);
  // Past the interval while that sync still runs: still no new round.
  h.context.githubIssueSyncLastRunAt.set(h.github.id, Date.now() - 600_000);
  await h.context.pollGithub(h.github);
  assert.deepEqual([boardReads, syncs], [1, 1]);
  // A manual poll returns without blocking on the sync; its issueSync waits
  // for the running sync, then runs a fresh one.
  const manual = await h.context.pollGithub(h.github, true);
  assert.deepEqual([boardReads, syncs], [2, 1]);
  releases[0]({ synced: 4, recovered: 0, backfilled: 0 });
  await settle();
  assert.equal(syncs, 2);
  releases[1]({ synced: 5, recovered: 0, backfilled: 0 });
  assert.equal((await manual.issueSync).synced, 5);
});

test("a seeding poll reads the board even within the issue-sync interval", async () => {
  const h = harness();
  h.state.rules.push({
    id: "sync",
    enabled: true,
    kind: "github_issue_sync",
    config: { githubConnectorId: h.github.id, githubProjectId: "project-1" },
  });
  h.context.pollGithubReviews = async () => ({ processed: 0 });
  h.context.reconcileGithubIssueRules = async () => ({ synced: 0 });
  h.context.githubGraphql = async () => ({});
  let boardReads = 0;
  h.context.loadGithubProjectIssues = async () => {
    boardReads += 1;
    return [];
  };
  h.context.githubIssueSyncLastRunAt.set(h.github.id, Date.now());
  h.github.config.cursorTs = undefined;
  h.github.config.seenIds = [];
  await h.context.pollGithub(h.github);
  assert.equal(boardReads, 1);
});
