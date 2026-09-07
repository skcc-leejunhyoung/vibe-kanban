// Real remote-web/host integration; no mocked transport. Run against an isolated
// test account with the remote Vite shell and backend registered to its relay.
// ARTIFACT_REMOTE_CONTEXT: JSON {remote_url, backend_port, email, password}.
// ARTIFACT_CHAT_CONTEXT: JSON with claude/codex {workspace_id, session_id,
// process_id, artifact_id}; produce these with ordinary unmodified CLI runs.
// The saved reports/overview.html should contain a button that increments to 1.
// Set ARTIFACT_TEST_SELF_SIGNED=1 only for a disposable local TLS test proxy.
// Optional ARTIFACT_RECONNECT_TEST=1 prints DISCONNECT_READY / RECONNECT_READY;
// the test driver stops / restarts its isolated host and sends a newline for
// each. This script never restarts a host itself or exports pairing keys.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const context = JSON.parse(
  await readFile(process.env.ARTIFACT_REMOTE_CONTEXT, "utf8"),
);
const scopes = JSON.parse(
  await readFile(process.env.ARTIFACT_CHAT_CONTEXT, "utf8"),
);
const root = process.cwd();
const shared = `/@fs${root}/packages/web-core/src/shared/lib`;
const remoteUrl = context.remote_url;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
});
try {
  const page = await browser.newPage({
    ignoreHTTPSErrors: process.env.ARTIFACT_TEST_SELF_SIGNED === "1",
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(30000);
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("response", (r) => {
    if (r.status() >= 400)
      console.log("http", r.status(), new URL(r.url()).pathname);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error")
      console.log("console", msg.text().slice(0, 250));
  });
  page.on("pageerror", (error) =>
    console.log("pageerror", error.message.slice(0, 150)),
  );
  await page.goto(`${remoteUrl}/account`);
  await page.getByLabel("Email", { exact: true }).fill(context.email);
  await page.getByLabel("Password", { exact: true }).fill(context.password);
  await page
    .getByRole("button", { name: "Sign in with email", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname !== "/account");
  console.log("Remote test account login passed");
  const enrollment = await (
    await fetch(
      `http://127.0.0.1:${context.backend_port}/api/relay-auth/server/enrollment-code`,
      { method: "POST" },
    )
  ).json();
  const hostId = await page.evaluate(
    async ({ shared, code }) => {
      const { listRelayHosts } = await import(`${shared}/remoteApi.ts`);
      const hosts = await listRelayHosts();
      if (hosts.length !== 1)
        throw new Error("Expected exactly one isolated test host");
      const host = hosts[0];
      const b = await import(`${shared}/relayBackendApi.ts`);
      const p = await import(`${shared}/relayPake.ts`);
      const { savePairedRelayHost } = await import(
        `${shared}/relayPairingStorage.ts`
      );
      const auth = await b.createRemoteSession(host.id);
      const { state, clientMessageB64 } = await p.startSpake2Enrollment(code);
      const start = await b.startRelaySpake2Enrollment(
        host.id,
        auth.session_id,
        { enrollment_code: code, client_message_b64: clientMessageB64 },
      );
      const key = await p.finishSpake2Enrollment(
        state,
        start.server_message_b64,
      );
      const signing = await p.generateRelaySigningKeyPair();
      const clientId = crypto.randomUUID();
      const finish = await b.finishRelaySpake2Enrollment(
        host.id,
        auth.session_id,
        {
          enrollment_id: start.enrollment_id,
          client_id: clientId,
          client_name: "Artifact browser smoke",
          client_browser: "Chromium",
          client_os: "test",
          client_device: "test",
          public_key_b64: signing.publicKeyB64,
          client_proof_b64: await p.buildClientProofB64(
            key,
            start.enrollment_id,
            signing.publicKeyBytes,
          ),
        },
      );
      if (
        !(await p.verifyServerProof(
          key,
          start.enrollment_id,
          signing.publicKeyBytes,
          finish.server_public_key_b64,
          finish.server_proof_b64,
        ))
      )
        throw new Error("Invalid pairing proof");
      await savePairedRelayHost({
        host_id: host.id,
        host_name: host.name,
        client_id: clientId,
        client_name: "Artifact browser smoke",
        signing_session_id: finish.signing_session_id,
        public_key_b64: signing.publicKeyB64,
        private_key: signing.privateKey,
        server_public_key_b64: finish.server_public_key_b64,
        paired_at: new Date().toISOString(),
      });
      return host.id;
    },
    { shared, code: enrollment.data.enrollment_code },
  );
  console.log("Real relay PAKE pairing passed");
  const forbiddenHost = page.waitForResponse(
    (response) =>
      response.url().includes("/v1/relay/create/") && response.status() === 403,
  );
  const unknownHostRejected = await page.evaluate(async (shared) => {
    const { createRemoteSession } = await import(
      `${shared}/relayBackendApi.ts`
    );
    try {
      await createRemoteSession(crypto.randomUUID());
      return false;
    } catch {
      return true;
    }
  }, shared);
  assert(unknownHostRejected, "Unknown remote host must be rejected");
  await forbiddenHost;

  const findCard = async (name) => {
    const card = page.locator("div.my-half").filter({
      has: page.getByText(name, { exact: true }),
    });
    await page.locator("[data-row-index]").first().waitFor();
    const scroll = page.locator("div.h-full.overflow-y-auto.scrollbar-none");
    // Loading older turns preserves the viewport; return to the top until
    // they are available, then scan the actual virtualized conversation.
    for (let n = 0; n < 20 && !(await card.isVisible()); n++) {
      await scroll.evaluate((el) => el.scrollTo({ top: 0 }));
      await page.waitForTimeout(150);
      await page
        .getByText("Loading earlier messages", { exact: true })
        .waitFor({ state: "hidden" });
    }
    for (let n = 0; n < 80 && !(await card.isVisible()); n++) {
      await page.waitForTimeout(150);
      if (n > 2)
        await scroll.evaluate((el) => el.scrollBy(0, el.clientHeight / 2));
    }
    await card.waitFor();
    return card;
  };

  for (const executor of ["claude", "codex"]) {
    const s = scopes[executor];
    await page.goto(
      `${remoteUrl}/hosts/${hostId}/workspaces/${s.workspace_id}`,
    );
    await page.evaluate(
      async ({ shared, s, hostId }) => {
        const { artifactsApi } = await import(`${shared}/api.ts`);
        const list = await artifactsApi.list(
          s.process_id,
          s.workspace_id,
          s.session_id,
          hostId,
        );
        if (
          !list.complete ||
          !list.artifacts.some((a) => a.id === s.artifact_id)
        )
          throw new Error("Completed snapshot missing");
        const rejected = async (request) => {
          try {
            await request;
          } catch (error) {
            if (error.statusCode !== 400) throw error;
            return;
          }
          throw new Error("Cross-scope request succeeded");
        };
        await rejected(
          artifactsApi.list(
            s.process_id,
            crypto.randomUUID(),
            s.session_id,
            hostId,
          ),
        );
        await rejected(
          artifactsApi.list(
            s.process_id,
            s.workspace_id,
            crypto.randomUUID(),
            hostId,
          ),
        );
        await rejected(
          artifactsApi.content(
            s.process_id,
            s.workspace_id,
            s.session_id,
            s.artifact_id,
            hostId,
            "0".repeat(64),
          ),
        );
      },
      { shared, s, hostId },
    );
    const card = await findCard("reports/overview.html");
    assert.equal(await card.count(), 1);
    await card.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const doc = dialog.frameLocator("iframe").frameLocator("iframe");
    await doc.getByRole("button").first().click();
    assert.match(await doc.locator("body").innerText(), /\b1\b/);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await card.getByRole("button", { name: "Preview", exact: true }).click();
    await dialog
      .getByRole("switch", { name: "View source", exact: true })
      .check();
    assert.match(
      await dialog.locator("pre").innerText(),
      /<(?:!doctype|html)/i,
    );
    const d = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download", exact: true }).click();
    assert.equal((await d).suggestedFilename(), "overview.html");
    await page.reload();
    await findCard("reports/overview.html");
    console.log(
      executor,
      "remote card, interaction, source, download and reload passed",
    );
    if (s.mcp_image_name) {
      const mcpCard = await findCard(s.mcp_image_name);
      assert.equal(
        await page.getByText(s.mcp_image_copy_name, { exact: true }).count(),
        0,
      );
      await mcpCard
        .getByRole("button", { name: "Preview", exact: true })
        .click();
      const image = dialog.getByRole("img");
      await image.waitFor();
      await image.evaluate((node) => node.decode());
      assert(await image.evaluate((node) => node.naturalWidth > 0));
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      console.log(
        "Real MCP image preview and deduplication passed through the signed host relay",
      );
    }
  }
  assert(
    requests.some(
      (url) =>
        url.includes(`/v1/relay/h/${hostId}/`) &&
        url.includes("/artifacts/content"),
    ),
  );
  assert(
    !requests.some(
      (url) =>
        url.startsWith(`${remoteUrl}/api/`) && url.includes("/artifacts"),
    ),
  );

  console.log("Host-scoped signed relay transport verified");
  if (process.env.ARTIFACT_RECONNECT_TEST === "1") {
    console.log("DISCONNECT_READY");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    const s = scopes.codex;
    const unavailable = await page.evaluate(
      async ({ shared, s, hostId }) => {
        const { artifactsApi } = await import(`${shared}/api.ts`);
        try {
          await artifactsApi.list(
            s.process_id,
            s.workspace_id,
            s.session_id,
            hostId,
            AbortSignal.timeout(8000),
          );
          return false;
        } catch {
          return true;
        }
      },
      { shared, s, hostId },
    );
    assert(
      unavailable,
      "Disconnected hosts must not return another host's snapshot",
    );
    console.log("RECONNECT_READY");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    // Keep the browser's nonextractable signing key and resume the same pairing.
    await page.reload();
    const restored = await findCard("reports/overview.html");
    await restored
      .getByRole("button", { name: "Preview", exact: true })
      .click();
    const doc = page
      .getByRole("dialog")
      .frameLocator("iframe")
      .frameLocator("iframe");
    await doc.getByRole("button").first().click();
    assert.match(await doc.locator("body").innerText(), /\b1\b/);
    const hash = await page.evaluate(
      async ({ shared, s, hostId }) => {
        const { artifactsApi } = await import(`${shared}/api.ts`);
        return (
          await artifactsApi.list(
            s.process_id,
            s.workspace_id,
            s.session_id,
            hostId,
          )
        ).artifacts.find((artifact) => artifact.id === s.artifact_id)
          ?.content_hash;
      },
      { shared, s, hostId },
    );
    assert.equal(hash, s.artifact_hash);
    console.log(
      "Actual host disconnect, restart, same-browser pairing and immutable preview passed",
    );
    process.stdin.pause();
  }
} finally {
  await browser.close();
}
