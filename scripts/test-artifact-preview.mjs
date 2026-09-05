// Browser integration for the actual shared preview builder. Install Playwright
// in the test environment, or set PLAYWRIGHT_MODULE / PLAYWRIGHT_CHROMIUM_PATH.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const compiled = await build({
  entryPoints: [
    "packages/web-core/src/features/workspace-chat/ui/artifact-preview.ts",
  ],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ArtifactPreview",
});
const requests = [];
const server = createServer((request, response) => {
  if (request.url !== "/") requests.push(request.url);
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<!doctype html><title>Artifact isolation test</title><body>Parent application</body>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
  headless: true,
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    localStorage.setItem("app-secret", "parent-only");
  });
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const load = async (source, resources = [], svg = false) => {
    await page.evaluate(
      ({ source, resources, svg }) => {
        document.querySelector("iframe")?.remove();
        const preview = window.ArtifactPreview.buildArtifactPreview(
          source,
          "reports/index.html",
          resources.map((resource) => ({
            ...resource,
            bytes: new TextEncoder().encode(resource.text),
          })),
          svg,
        );
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        frame.referrerPolicy = "no-referrer";
        frame.srcdoc = preview.srcDoc;
        document.body.append(frame);
      },
      { source, resources, svg },
    );
    const inner = page.frameLocator("iframe").frameLocator("iframe");
    await inner.locator("body").waitFor({ state: "attached" });
    return inner;
  };
  let inner = await load(
    '<html><head><link rel="stylesheet" href="style.css"></head><body><button id="counter">0</button><script src="app.js"></script></body></html>',
    [
      {
        path: "reports/style.css",
        mime: "text/css",
        text: "body { background: rgb(1, 2, 3); }",
      },
      {
        path: "reports/app.js",
        mime: "text/javascript",
        text: 'document.querySelector("button").onclick = e => e.target.textContent = Number(e.target.textContent) + 1;',
      },
    ],
  );
  await inner.locator("#counter").click();
  assert.equal(await inner.locator("#counter").textContent(), "1");
  assert.equal(
    await inner
      .locator("body")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgb(1, 2, 3)",
  );
  await page.evaluate(() => {
    window.escapeMessages = 0;
    addEventListener("message", (event) => {
      if (
        event.source === document.querySelector("iframe").contentWindow &&
        event.data === "vibe:artifact:escape"
      )
        window.escapeMessages++;
    });
  });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.escapeMessages === 1);
  const attacks = `<html><body><pre id="result"></pre><form action="/api/forbidden"><button>submit</button></form><script>
    const results = {};
    try { results.parent = parent.document.body.textContent; } catch { results.parent = 'blocked'; }
    try { results.storage = localStorage.getItem('app-secret'); } catch { results.storage = 'blocked'; }
    try { results.popup = window.open('/api/forbidden') ? 'opened' : 'blocked'; } catch { results.popup = 'blocked'; }
    try { top.location.href = '/api/forbidden'; results.top = 'opened'; } catch { results.top = 'blocked'; }
    fetch('/api/forbidden').then(() => results.fetch = 'opened').catch(() => results.fetch = 'blocked').finally(() => document.querySelector('#result').textContent = JSON.stringify(results));
    document.querySelector('form').submit();
  </script></body></html>`;
  inner = await load(attacks);
  await inner.locator("#result").filter({ hasText: "fetch" }).waitFor();
  assert.deepEqual(JSON.parse(await inner.locator("#result").textContent()), {
    parent: "blocked",
    storage: "blocked",
    popup: "blocked",
    top: "blocked",
    fetch: "blocked",
  });
  const parentUrl = page.url();
  await load(
    `<html><body><img src="${parentUrl}api/forbidden?image"><link rel="stylesheet" href="${parentUrl}api/forbidden?style"><iframe src="${parentUrl}api/forbidden?frame"></iframe><script src="${parentUrl}api/forbidden?script"></script><p style="background:url(${parentUrl}api/forbidden?css)">external resources</p></body></html>`,
  );
  await page.waitForTimeout(200);
  assert(!requests.some((url) => url.startsWith("/api/")));
  await page.evaluate(() => {
    window.previewErrors = [];
    addEventListener("message", (event) => {
      if (
        event.source === document.querySelector("iframe").contentWindow &&
        event.data?.type === "vibe:artifact:error"
      )
        window.previewErrors.push(event.data.message);
    });
  });
  await load("<html><body><script>const = ;</script></body></html>");
  await page.waitForFunction(() => window.previewErrors.length > 0);
  await load(
    '<html><body><script>setTimeout(() => location.href = "' +
      parentUrl +
      'api/forbidden?leak=secret", 50)</script></body></html>',
  );
  await page.waitForTimeout(200);
  assert.equal(page.url(), parentUrl);
  assert(!requests.some((url) => url.startsWith("/api/")));
  inner = await load(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="top.location=\'/api/forbidden\'"><script>fetch("/api/forbidden")</script><circle cx="20" cy="20" r="10"/></svg>',
    [],
    true,
  );
  assert.equal(await inner.locator("svg script").count(), 0);
  assert.equal(await inner.locator("svg").getAttribute("onload"), null);
  assert(!requests.some((url) => url.startsWith("/api/")));
  console.log(
    `Artifact browser integration passed (Chromium ${browser.version()}): CSS/JS interaction, parent/storage/API/popup/form/top/self navigation, SVG isolation.`,
  );
  // Optional live check against an isolated Vibe instance, after ordinary CLI
  // quick-chat runs. The context file supplies each run's workspace_id only;
  // no mocked routes, artifact protocol, browser credentials or agent changes.
  if (process.env.ARTIFACT_SMOKE_CONTEXT) {
    const scopes = JSON.parse(
      await readFile(process.env.ARTIFACT_SMOKE_CONTEXT, "utf8"),
    );
    for (const executor of ["claude", "codex"]) {
      const chat = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await chat.goto(
        `${process.env.ARTIFACT_WEB_URL}/workspaces/${scopes[executor].workspace_id}`,
      );
      const card = chat.locator("div.my-half").filter({
        has: chat.getByText(/(?:reports\/)?overview\.html/, { exact: true }),
      });
      await card.waitFor({ timeout: 30000 });
      assert.equal(await card.count(), 1);
      await card.getByRole("button", { name: "Preview", exact: true }).click();
      const dialog = chat.getByRole("dialog");
      const document = dialog.frameLocator("iframe").frameLocator("iframe");
      await document.getByRole("button").first().click();
      assert.match(await document.locator("body").innerText(), /\b1\b/);
      await chat.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await card.getByRole("button", { name: "Source", exact: true }).click();
      assert.match(
        await dialog.locator("pre").innerText(),
        /<(?:!doctype|html)/i,
      );
      await chat.keyboard.press("Escape");
      const download = chat.waitForEvent("download");
      await card.getByRole("button", { name: "Download", exact: true }).click();
      assert.equal((await download).suggestedFilename(), "overview.html");
      await chat.reload();
      await card.waitFor();
      console.log(
        `${executor}: real chat card, interaction, Escape, source, download and reload passed`,
      );
      if (executor === "claude" && scopes.claude.format_process_id) {
        const namedCard = (name) =>
          chat
            .locator("div.my-half")
            .filter({ has: chat.getByText(name, { exact: true }) });
        const openFile = (name) =>
          namedCard(name)
            .getByRole("button", { name: "Preview", exact: true })
            .click();
        const close = async () => {
          await chat.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
        };
        await openFile("out/drawing.svg");
        await dialog
          .frameLocator("iframe")
          .frameLocator("iframe")
          .locator("svg circle")
          .waitFor();
        await dialog
          .frameLocator("iframe")
          .frameLocator("iframe")
          .locator("svg circle")
          .click();
        await close();
        await openFile("out/broken.mmd");
        await dialog
          .getByText("Mermaid diagram error", { exact: true })
          .waitFor();
        assert.match(
          await dialog.locator("pre").innerText(),
          /deliberately invalid/,
        );
        await close();
        await openFile("block-2.mmd");
        await dialog.locator("svg").waitFor();
        await close();
        await openFile("reports/README.md");
        await dialog.locator(".markdown-preview h1").waitFor();
        await dialog.locator(".markdown-preview svg").waitFor();
        await close();
        const app = namedCard("out/Example.tsx");
        assert.equal(
          await app
            .getByRole("button", { name: "Preview", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await app
            .getByRole("button", {
              name: "Development server Preview",
              exact: true,
            })
            .count(),
          1,
        );
        await app.getByRole("button", { name: "Source", exact: true }).click();
        await dialog.locator("pre").waitFor();
        assert.match(
          await dialog.locator("pre").innerText(),
          /function Example/,
        );
        await close();
        const pdf = namedCard("out/sample.pdf");
        assert.equal(
          await pdf
            .getByRole("button", { name: "Preview", exact: true })
            .count(),
          0,
        );
        const downloaded = chat.waitForEvent("download");
        await pdf
          .getByRole("button", { name: "Download", exact: true })
          .click();
        assert.equal((await downloaded).suggestedFilename(), "sample.pdf");
        console.log(
          "Real format cards passed: SVG, Mermaid success/error, Markdown, TSX source/dev-preview distinction, PDF download.",
        );
      }
      await chat.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
