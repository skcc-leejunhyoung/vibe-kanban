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
const components = await build({
  stdin: {
    contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import NiceModal from '@ebay/nice-modal-react';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import i18n from 'i18next';
      import { initReactI18next } from 'react-i18next';
      import korean from './src/i18n/locales/ko/common.json';
      import { MermaidDiagram } from './src/shared/components/MermaidDiagram';
      import { MarkdownPreview } from './src/shared/components/MarkdownPreview';
      import WYSIWYGEditor from './src/shared/components/WYSIWYGEditor';
      import { SubagentTranscriptDialog } from './src/shared/dialogs/SubagentTranscriptDialog';
      import { HostIdContext } from './src/shared/providers/HostIdProvider';
      import { setLocalApiTransport } from './src/shared/lib/localApiTransport';
      void i18n.use(initReactI18next).init({lng: 'cimode', defaultNS: 'common',
        resources: {ko: {common: korean}}, initImmediate: false});
      window.setArtifactLanguage = language => i18n.changeLanguage(language);
      const element = document.createElement('div'); document.body.append(element);
      const root = createRoot(element);
      window.renderArtifactDiagram = chart => root.render(React.createElement(MermaidDiagram, {chart, theme: 'light', isolated: true}));
      window.renderArtifactMarkdown = content => root.render(React.createElement(MarkdownPreview, {content, theme: 'light', allowRemoteImages: false}));
      const client = new QueryClient();
      window.renderChatMarkdown = value => root.render(
        React.createElement(QueryClientProvider, {client},
          React.createElement(NiceModal.Provider, null,
            React.createElement(WYSIWYGEditor, {value, disabled: true, hideActions: true,
              renderMermaidArtifacts: true,
              onEditorStateChange: state => { window.chatEditorState = state.toJSON(); }
            }))));
      window.hostRequests = [];
      window.artifactSource = '<!doctype html><html><body><button onclick="this.textContent = &quot;clicked&quot;">saved report</button></body></html>';
      window.artifact = {id: 'report', name: 'child.html', mime: 'text/html', status: 'ready',
        execution_id: 'process', content_hash: 'hash', source_entry: 0,
        source_scope: 'child', source: 'inline', size_bytes: 120};
      setLocalApiTransport({request: async path => {
        window.hostRequests.push(path);
        if (path.includes('/content?')) return new Response(window.artifactSource);
        const data = path.includes('/bundle?')
          ? {artifact: window.artifact, resources: [], warnings: []}
          : {content: 'Child report', entries: [], artifacts: [window.artifact]};
        return new Response(JSON.stringify({success: true, data}), {headers: {'Content-Type': 'application/json'}});
      }});
      window.setDocumentHost = host => flushSync(() => root.render(
        React.createElement(HostIdContext.Provider, {value: host},
          React.createElement(QueryClientProvider, {client}, React.createElement(NiceModal.Provider)))));
      window.openTranscript = hostId => {
        window.setDocumentHost('document-host');
        void SubagentTranscriptDialog.show({hostId, processId: 'process',
          target: {executor: 'codex', thread_id: 'child'}, title: 'Child transcript',
          workspaceWithSession: {id: 'workspace', session: {id: 'session'}},
          resetAction: {}, repos: [], changesViewActions: {},
        });
      };
      window.removeTranscript = () => SubagentTranscriptDialog.remove();`,
    resolveDir: `${process.cwd()}/packages/web-core`,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  define: { "import.meta.env": "{}", "import.meta.hot": "undefined" },
  plugins: [
    {
      // Keep the actual modal, card and API transport; unrelated conversation
      // entry renderers have their own tests and need the full workspace shell.
      name: "transcript-entry-boundary",
      setup(build) {
        build.onResolve({ filter: /\/DisplayConversationEntry$/ }, () => ({
          path: "transcript-entry",
          namespace: "transcript-entry",
        }));
        build.onLoad({ filter: /.*/, namespace: "transcript-entry" }, () => ({
          contents: `import React from 'react';
            import { ArtifactCards } from './src/features/workspace-chat/ui/ArtifactCards';
            export default function Entry(props) {
              return React.createElement(ArtifactCards, {artifacts: props.artifactOverrides,
                processId: props.executionProcessId, workspaceId: 'workspace', sessionId: 'session'});
            }`,
          resolveDir: `${process.cwd()}/packages/web-core`,
          loader: "jsx",
        }));
      },
    },
    {
      name: "vite-raw-import",
      setup(build) {
        build.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: require.resolve(args.path.slice(0, -4), {
            paths: [args.resolveDir],
          }),
          namespace: "raw",
        }));
        build.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
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
  if (process.env.ARTIFACT_PREVIEW_CSS) {
    await page.addStyleTag({ path: process.env.ARTIFACT_PREVIEW_CSS });
    await page.evaluate(() =>
      document.documentElement.classList.add("new-design"),
    );
  }
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
  const invalidSvg = await page.evaluate(() => {
    try {
      window.ArtifactPreview.buildArtifactPreview(
        "<svg><path></svg>",
        "broken.svg",
        [],
        true,
      );
    } catch (error) {
      return error.message;
    }
  });
  assert.match(invalidSvg, /Invalid SVG/);
  console.log(
    `Artifact browser integration passed (Chromium ${browser.version()}): CSS/JS interaction, parent/storage/API/popup/form/top/self navigation, SVG isolation.`,
  );
  await page.evaluate(() => document.querySelector("iframe")?.remove());
  await page.addScriptTag({ content: components.outputFiles[0].text });
  const fence = "```";
  await page.evaluate(
    (value) => window.renderChatMarkdown(value),
    [
      fence + "gh-comment",
      JSON.stringify({
        id: "review-1",
        comment_type: "review",
        author: "reviewer",
        body: "Review comment",
        created_at: "2026-09-08T00:00:00Z",
      }),
      fence,
      fence + "vk-component",
      JSON.stringify({
        framework: "react",
        component: "Button",
        htmlPreview: "<button>Click</button>",
      }),
      fence,
      fence + "mermaid vibe-artifact",
      "flowchart LR\n A-->B",
      fence,
      "~~~~text",
      fence + "mermaid vibe-artifact",
      "flowchart LR\n Example-->Only",
      fence,
      "~~~~",
    ].join("\n"),
  );
  await page.waitForFunction(() => {
    const types = JSON.stringify(window.chatEditorState ?? null);
    return (
      types.includes('"type":"github-comment"') &&
      types.includes('"type":"component-info"') &&
      types.includes('"type":"mermaid-artifact"')
    );
  });
  assert.equal(await page.getByText("@reviewer", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Button", { exact: true }).count(), 1);
  assert.equal(
    await page.locator('iframe[title="Mermaid diagram"]').count(),
    1,
  );
  await page
    .frameLocator('iframe[title="Mermaid diagram"]')
    .frameLocator("iframe")
    .locator("svg")
    .waitFor();
  console.log(
    "Chat Markdown preserves PR/component cards, renders selected Mermaid, and keeps nested examples as code.",
  );
  await page.evaluate(() =>
    window.renderArtifactDiagram("flowchart LR\n A-->B"),
  );
  const diagram = page
    .frameLocator('iframe[title="Mermaid diagram"]')
    .frameLocator("iframe");
  await diagram.locator("#diagram svg").waitFor();
  assert.match(await diagram.locator("#diagram").innerText(), /A/);
  const diagramHeight = await diagram
    .locator("#diagram")
    .evaluate((node) =>
      Math.max(80, Math.ceil(node.getBoundingClientRect().height)),
    );
  await page.waitForFunction(
    (height) =>
      document.querySelector('iframe[title="Mermaid diagram"]').clientHeight ===
      height,
    diagramHeight,
  );
  await page.evaluate(() => {
    window.diagramEscapes = 0;
    addEventListener("keydown", (event) => {
      if (event.key === "Escape") window.diagramEscapes++;
    });
  });
  await diagram.locator("#diagram svg").click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.diagramEscapes === 1);
  await page.evaluate(() =>
    window.renderArtifactDiagram("deliberately invalid diagram"),
  );
  await page.getByText("Mermaid diagram error", { exact: true }).waitFor();
  const remoteImageChart = `flowchart LR\n A@{ img: "${parentUrl}api/mermaid-image", label: "blocked image" }`;
  await page.evaluate(() =>
    window.renderArtifactDiagram("flowchart LR\n Ready-->Next"),
  );
  await diagram.locator("#diagram svg").waitFor();
  await page.evaluate(
    (chart) => window.renderArtifactDiagram(chart),
    remoteImageChart,
  );
  await page.getByText("Mermaid diagram error", { exact: true }).waitFor();
  assert.equal(await page.locator("pre code").textContent(), remoteImageChart);
  await page.evaluate(
    (chart) =>
      window.renderArtifactMarkdown(
        `# Artifact\n![blocked](/api/markdown-image)\n\n\`\`\`mermaid\n${chart}\n\`\`\``,
      ),
    remoteImageChart,
  );
  await page.locator(".markdown-preview h1").waitFor();
  await page
    .locator(".markdown-preview")
    .getByText("Mermaid diagram error", { exact: true })
    .waitFor();
  assert(!requests.some((url) => url.startsWith("/api/")));
  await page.evaluate(() =>
    window.renderArtifactMarkdown(
      "# Artifact\n\n```mermaid\nflowchart TD\n A-->B\n```",
    ),
  );
  await diagram.locator("#diagram svg").waitFor();
  console.log(
    "Isolated Mermaid and Markdown passed: rendering, resize, Escape, parse errors, blocked image requests.",
  );
  for (const host of ["pane-host", null]) {
    await page.evaluate((hostId) => window.openTranscript(hostId), host);
    const card = page
      .locator("div.my-half")
      .filter({ has: page.getByText("child.html", { exact: true }) });
    await card.waitFor();
    assert.equal(await card.getByRole("button").count(), 2);
    assert.equal(
      await card.getByRole("button", { name: "artifacts.download" }).count(),
      0,
    );
    assert.equal(
      await card.getByRole("button", { name: "artifacts.source" }).count(),
      0,
    );
    assert.deepEqual(await card.getByRole("button").allTextContents(), [
      "",
      "",
    ]);
    if (process.env.ARTIFACT_PREVIEW_CSS) {
      const title = await card
        .getByText("child.html", { exact: true })
        .boundingBox();
      const action = await card
        .getByRole("button", { name: "artifacts.preview", exact: true })
        .boundingBox();
      assert(
        action.x >= title.x + title.width,
        "card actions belong to the right of the description",
      );
    }
    if (process.env.ARTIFACT_PREVIEW_SCREENSHOT && host) {
      await page.evaluate(() => window.setArtifactLanguage("ko"));
      await card
        .getByRole("button", { name: "미리보기", exact: true })
        .waitFor();
      await page.screenshot({
        path: process.env.ARTIFACT_PREVIEW_SCREENSHOT.replace(
          ".png",
          "-card.png",
        ),
      });
      await page.evaluate(() => window.setArtifactLanguage("cimode"));
    }
    await page.evaluate(() => window.setDocumentHost("another-document-host"));
    await card
      .getByRole("button", { name: "artifacts.preview", exact: true })
      .click();
    const preview = page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: "child.html", exact: true }),
    });
    const document = preview.frameLocator("iframe").frameLocator("iframe");
    await document.getByRole("button", { name: "saved report" }).click();
    await document.getByRole("button", { name: "clicked" }).waitFor();
    const sourceToggle = preview.getByRole("switch", {
      name: "artifacts.source",
    });
    assert.equal(await sourceToggle.isChecked(), false);
    await sourceToggle.check();
    await preview.locator("pre").waitFor();
    assert.match(await preview.locator("pre").innerText(), /<html>/);
    assert.equal(await preview.locator("iframe").count(), 0);
    await sourceToggle.uncheck();
    await document.getByRole("button", { name: "saved report" }).waitFor();
    const download = page.waitForEvent("download");
    await preview
      .getByRole("button", { name: "artifacts.download", exact: true })
      .click();
    assert.equal((await download).suggestedFilename(), "child.html");
    await sourceToggle.check();
    await preview.locator("pre").waitFor();
    if (process.env.ARTIFACT_PREVIEW_SCREENSHOT && host) {
      await page.evaluate(() => window.setArtifactLanguage("ko"));
      await preview
        .getByRole("button", { name: "다운로드", exact: true })
        .waitFor();
      await page.screenshot({ path: process.env.ARTIFACT_PREVIEW_SCREENSHOT });
      await page.setViewportSize({ width: 390, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "mobile dialog must not overflow horizontally",
      );
      await page.screenshot({
        path: process.env.ARTIFACT_PREVIEW_SCREENSHOT.replace(
          ".png",
          "-mobile.png",
        ),
      });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.evaluate(() => window.setArtifactLanguage("cimode"));
    }
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    await card
      .getByRole("button", { name: "artifacts.preview", exact: true })
      .click();
    assert.equal(
      await preview.getByRole("switch").isChecked(),
      false,
      "reopening starts in preview",
    );
    await document.getByRole("button", { name: "saved report" }).waitFor();
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    const hostRequests = await page.evaluate(() =>
      window.hostRequests.splice(0),
    );
    const prefix = host ? `/api/host/${host}/` : "/api/";
    assert(hostRequests.some((path) => path.includes("/bundle?")));
    assert(hostRequests.some((path) => path.includes("/content?")));
    assert(
      hostRequests.every((path) =>
        path.startsWith(`${prefix}execution-processes/process/`),
      ),
    );
    await page.evaluate(() => window.removeTranscript());
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  console.log(
    "Artifact controls passed: right-side icons, source toggle, preview reset and dialog download retain pane host or explicit local host after document navigation.",
  );
  await page.evaluate(() => {
    window.artifact = {
      ...window.artifact,
      name: "sample.pdf",
      mime: "application/pdf",
    };
    window.artifactSource = "%PDF-download-fixture";
    window.openTranscript("pane-host");
  });
  await page
    .getByRole("button", { name: "artifacts.preview", exact: true })
    .click();
  const binaryPreview = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "sample.pdf", exact: true }),
  });
  await binaryPreview.getByText("artifacts.binary", { exact: true }).waitFor();
  assert.equal(await binaryPreview.getByRole("switch").count(), 0);
  const binaryDownload = page.waitForEvent("download");
  await binaryPreview
    .getByRole("button", { name: "artifacts.download", exact: true })
    .click();
  const binaryFile = await binaryDownload;
  assert.equal(binaryFile.suggestedFilename(), "sample.pdf");
  assert.equal(
    await readFile(await binaryFile.path(), "utf8"),
    "%PDF-download-fixture",
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.removeTranscript());
  await page.evaluate(() => {
    window.artifact = {
      ...window.artifact,
      name: "invalid.svg",
      mime: "image/svg+xml",
    };
    window.artifactSource = "<svg><path></svg>";
    window.openTranscript("pane-host");
  });
  await page
    .getByRole("button", { name: "artifacts.preview", exact: true })
    .click();
  const invalidPreview = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "invalid.svg", exact: true }),
  });
  await invalidPreview.getByRole("alert").waitFor();
  await invalidPreview
    .getByRole("switch", { name: "artifacts.source" })
    .check();
  await invalidPreview.locator("pre").waitFor();
  assert.equal(
    await invalidPreview.locator("pre").innerText(),
    "<svg><path></svg>",
  );
  assert(
    await invalidPreview
      .getByRole("button", { name: "artifacts.download", exact: true })
      .isEnabled(),
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.removeTranscript());
  console.log(
    "Binary download and source access after preview failure passed.",
  );
  // Use the same window.open contract as the installed PWA link helper.
  await page.evaluate((url) => {
    window.artifact = {
      ...window.artifact,
      name: "Published report",
      mime: "text/uri-list",
      url,
      content_hash: null,
    };
    window.artifactOpenCalls = [];
    window.originalArtifactOpen = window.open;
    window.open = (...args) => {
      window.artifactOpenCalls.push(args);
      return window.originalArtifactOpen(...args);
    };
    window.openTranscript("pane-host");
  }, `${parentUrl}published-report`);
  const popupPromise = page.waitForEvent("popup");
  await page
    .getByRole("link", { name: "artifacts.openOriginal", exact: true })
    .click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), `${parentUrl}published-report`);
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.deepEqual(await page.evaluate(() => window.artifactOpenCalls), [
    [`${parentUrl}published-report`, "_blank"],
  ]);
  await popup.close();
  await page.evaluate(() => {
    window.open = window.originalArtifactOpen;
    window.removeTranscript();
  });
  console.log(
    "Artifact links use the shared PWA window helper without a feature string and with opener cleared.",
  );
  // Optional live check against an isolated Vibe instance, after ordinary CLI
  // quick-chat runs with explicit vibe-artifact attachments. The context file
  // supplies each run's workspace_id; the application provides the attachment
  // instructions without modifying the CLI binaries.
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
      const findCard = async (name) => {
        const card = chat.locator("div.my-half").filter({
          has: chat.getByText(name, { exact: true }),
        });
        await chat
          .locator("[data-row-index]")
          .first()
          .waitFor({ timeout: 30000 });
        const scroll = chat.locator(
          "div.h-full.overflow-y-auto.scrollbar-none",
        );
        // Prepending older turns preserves the viewport. Keep moving to the
        // top while history loads before scanning through the virtual rows.
        for (let n = 0; n < 20 && !(await card.isVisible()); n++) {
          await scroll.evaluate((el) => el.scrollTo({ top: 0 }));
          await chat.waitForTimeout(150);
          await chat
            .getByText("Loading earlier messages", { exact: true })
            .waitFor({ state: "hidden" });
        }
        for (let n = 0; n < 80 && !(await card.isVisible()); n++) {
          await chat.waitForTimeout(150);
          if (n > 2)
            await scroll.evaluate((el) => el.scrollBy(0, el.clientHeight / 2));
        }
        await card.waitFor();
        return card;
      };
      const card = await findCard(/(?:reports\/)?overview\.html/);
      assert.equal(await card.count(), 1);
      await card.getByRole("button", { name: "Preview", exact: true }).click();
      const dialog = chat.getByRole("dialog");
      const document = dialog.frameLocator("iframe").frameLocator("iframe");
      await document.getByRole("button").first().click();
      assert.match(await document.locator("body").innerText(), /\b1\b/);
      await chat.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await card.getByRole("button", { name: "Preview", exact: true }).click();
      await dialog
        .getByRole("switch", { name: "View source", exact: true })
        .check();
      assert.match(
        await dialog.locator("pre").innerText(),
        /<(?:!doctype|html)/i,
      );
      const download = chat.waitForEvent("download");
      await dialog
        .getByRole("button", { name: "Download", exact: true })
        .click();
      assert.equal((await download).suggestedFilename(), "overview.html");
      await chat.reload();
      await findCard(/(?:reports\/)?overview\.html/);
      console.log(
        `${executor}: real chat card, interaction, Escape, source, download and reload passed`,
      );
      const imageName = scopes[executor].image_artifact_name;
      if (imageName) {
        const imageCard = await findCard(imageName);
        const image = chat.getByRole("img", {
          name: imageName.split("/").at(-1),
          exact: true,
        });
        await image.waitFor();
        assert.equal(await image.count(), 1);
        await image.click();
        await dialog.getByRole("img").waitFor();
        const previewImage = dialog.getByRole("img");
        await previewImage.evaluate((node) => node.decode());
        const ownedUrl = await previewImage.getAttribute("src");
        // An open modal must keep its bytes after the conversation row unmounts.
        await chat
          .locator("div.h-full.overflow-y-auto.scrollbar-none")
          .evaluate((el) => el.scrollTo({ top: 0 }));
        await image.waitFor({ state: "detached" });
        assert(
          await chat.evaluate(async (url) => (await fetch(url)).ok, ownedUrl),
        );
        assert(
          await dialog
            .getByRole("img")
            .evaluate((node) => node.naturalWidth > 0),
        );
        await chat.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert(
          await chat.evaluate(async (url) => {
            try {
              await fetch(url);
              return false;
            } catch {
              return true;
            }
          }, ownedUrl),
          "Closed image dialogs must revoke their own URL",
        );
        await findCard(imageName);
        const download = chat.waitForEvent("download");
        await imageCard
          .getByRole("button", { name: "Download", exact: true })
          .click();
        assert.equal(
          (await download).suggestedFilename(),
          imageName.split("/").at(-1),
        );
        console.log(
          "Native ImageGeneration: one inline image, existing image dialog and preserved download passed",
        );
      }
      if (scopes[executor].mcp_image_name) {
        const mcpCard = await findCard(scopes[executor].mcp_image_name);
        assert.equal(
          await chat
            .getByText(scopes[executor].mcp_image_copy_name, { exact: true })
            .count(),
          0,
        );
        await mcpCard
          .getByRole("button", { name: "Preview", exact: true })
          .click();
        const image = dialog.getByRole("img");
        await image.waitFor();
        await image.evaluate((node) => node.decode());
        assert(await image.evaluate((node) => node.naturalWidth > 0));
        const imageDownload = chat.waitForEvent("download");
        await dialog
          .getByRole("button", { name: "Download attachment", exact: true })
          .click();
        assert.equal(
          (await imageDownload).suggestedFilename(),
          scopes[executor].mcp_image_name.split("/").at(-1),
        );
        await chat.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        console.log(
          "Real MCP image: named file card, preserved preview and managed-copy deduplication passed",
        );
      }
      if (executor === "claude" && scopes.claude.format_process_id) {
        const openFile = async (name) =>
          (await findCard(name))
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
        await dialog
          .frameLocator("iframe")
          .frameLocator("iframe")
          .locator("#diagram svg")
          .waitFor();
        await close();
        await openFile("reports/README.md");
        await dialog.locator(".markdown-preview h1").waitFor();
        await dialog
          .locator(".markdown-preview")
          .frameLocator("iframe")
          .frameLocator("iframe")
          .locator("#diagram svg")
          .waitFor();
        await close();
        const app = await findCard("out/Example.tsx");
        assert.equal(
          await app
            .getByRole("button", { name: "Preview", exact: true })
            .count(),
          1,
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
        await app.getByRole("button", { name: "Preview", exact: true }).click();
        await dialog.locator("pre").waitFor();
        assert.match(
          await dialog.locator("pre").innerText(),
          /function Example/,
        );
        await close();
        const pdf = await findCard("out/sample.pdf");
        assert.equal(
          await pdf
            .getByRole("button", { name: "Preview", exact: true })
            .count(),
          1,
        );
        await pdf.getByRole("button", { name: "Preview", exact: true }).click();
        const downloaded = chat.waitForEvent("download");
        await dialog
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
  // Optional ordinary Claude Read / Codex ImageView executions over an existing
  // out/existing-circle.png. Each scope supplies workspace_id and session_id.
  if (process.env.ARTIFACT_READ_CONTEXT) {
    const scopes = JSON.parse(
      await readFile(process.env.ARTIFACT_READ_CONTEXT, "utf8"),
    );
    for (const [executor, scope] of Object.entries(scopes)) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      await page.goto(
        `${process.env.ARTIFACT_WEB_URL}/workspaces/${scope.workspace_id}`,
      );
      const image = page.getByRole("img", {
        name: "existing-circle.png",
        exact: true,
      });
      await image.waitFor();
      assert.equal(await image.count(), 1);
      await image.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("img").evaluate((node) => node.decode());
      const download = page.waitForEvent("download");
      await dialog
        .getByRole("button", { name: "Download attachment", exact: true })
        .click();
      assert.equal((await download).suggestedFilename(), "existing-circle.png");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      console.log(
        `${executor}: native existing image read, one inline image and existing dialog download passed`,
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
