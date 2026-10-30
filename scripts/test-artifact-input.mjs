// Browser regressions for the actual sandboxed input bridge, including the
// minified bootstrap used in production. Shares the preview test's Playwright setup.
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
  minify: true,
});
const cards = await build({
  stdin: {
    contents: `import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {QueryClient, QueryClientProvider, useQuery} from '@tanstack/react-query';
      import i18n from 'i18next';
      import {initReactI18next} from 'react-i18next';
      import {ArtifactCards} from './src/features/workspace-chat/ui/ArtifactCards';
      import {HostIdContext} from './src/shared/providers/HostIdProvider';
      import {workspaceSessionsQuery} from './src/shared/hooks/useWorkspaceSessions';
      import {setLocalApiTransport} from './src/shared/lib/localApiTransport';
      void i18n.use(initReactI18next).init({lng:'cimode', initImmediate:false});
      const interaction = {
        reference:{session_id:'session',execution_id:'process',request_id:'request'},
        workspace_id:'workspace',owner_host:'owner',owner_id:'owner',artifact_id:'form',
        artifact_hash:'html',version:'version',delivery:'service',handler:'session.rename',
        schema:{type:'object',properties:{name:{type:'string',maxLength:80}},required:['name']},
        state:'input_required',created_at:'',expires_at:'',result_process_id:null,error:null
      };
      const artifact = {id:'form',name:'rename.html',mime:'text/html',status:'ready',
        execution_id:'process',content_hash:'html',source:'inline',size_bytes:200};
      let name = 'Original session';
      window.renameRequests = [];
      setLocalApiTransport({request:async (path,init) => {
        window.renameRequests.push(path);
        let data;
        if (path.includes('/respond?')) {
          name = JSON.parse(init.body).response.data.name;
          interaction.state = 'completed';
          if (window.loseRenameReply) throw new Error('Lost response');
          data = interaction;
        } else if (path.includes('/artifacts/interactions?')) data = [interaction];
        else if (path.includes('/bundle?')) data = {artifact,resources:[],warnings:[]};
        else if (path.includes('/content?')) return new Response('<form data-vibe-form><input name="name" value="Updated session"><button>Rename</button></form>');
        else if (path.includes('/sessions?')) data = [{id:'session',name:path.includes('/other-host/')?'Other session':name}];
        else throw new Error('Unexpected request: '+path);
        return new Response(JSON.stringify({success:true,data}));
      }});
      function Sessions({hostId,id}) {
        const {data} = useQuery({...workspaceSessionsQuery('workspace',hostId),staleTime:Infinity});
        return <p id={id}>{data?.[0].name}</p>;
      }
      const root = createRoot(document.body.appendChild(document.createElement('div')));
      root.render(<QueryClientProvider client={new QueryClient()}>
        <Sessions hostId="artifact-host" id="session-name"/>
        <Sessions hostId="other-host" id="other-session-name"/>
        <HostIdContext.Provider value="artifact-host"><ArtifactCards artifacts={[artifact]} processId="process" workspaceId="workspace" sessionId="session"/></HostIdContext.Provider>
      </QueryClientProvider>);`,
    resolveDir: `${process.cwd()}/packages/web-core`,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  define: { "import.meta.env": "{}", "import.meta.hot": "undefined" },
  plugins: [
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
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><body>Artifact input test</body>");
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
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const load = async (source, resources = [], svg = false, input) => {
    await page.evaluate(
      ({ source, resources, svg, input }) => {
        document.querySelector("iframe")?.remove();
        const preview = window.ArtifactPreview.buildArtifactPreview(
          source,
          "reports/index.html",
          resources.map((resource) => ({
            ...resource,
            bytes: new TextEncoder().encode(resource.text),
          })),
          svg,
          input,
        );
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        frame.referrerPolicy = "no-referrer";
        frame.scrolling = "no";
        frame.style.cssText = "display:block;width:100%";
        frame.srcdoc = preview.srcDoc;
        document.body.append(frame);
      },
      { source, resources, svg, input },
    );
    const inner = page.frameLocator("iframe").frameLocator("iframe");
    await inner.locator("body").waitFor({ state: "attached" });
    return inner;
  };
  let inner;
  await page.evaluate(() => {
    window.inputMessages = [];
    addEventListener("message", (event) => {
      if (
        event.data?.type === "vibe:artifact:resize" &&
        Number.isFinite(event.data.height)
      ) {
        const frame = document.querySelector("iframe");
        if (event.source === frame?.contentWindow)
          frame.style.height = `${Math.max(1, Math.min(10000, event.data.height))}px`;
        return;
      }
      if (event.data?.type !== "vibe:artifact:input") return;
      window.inputMessages.push(event.data);
      if (event.data.event === "ready")
        event.source.postMessage(
          {
            type: "vibe:artifact:state",
            channel: "browser-input-test",
            value: {
              status: "input_required",
              message: "Ready",
              editable: true,
            },
            ...(window.restoredDraft ? { draft: window.restoredDraft } : {}),
          },
          "*",
        );
    });
  });
  const loadInput = async (html, arrayFields = [], actions) => {
    await page.evaluate(() => {
      window.inputMessages = [];
    });
    const frame = await load(html, [], false, {
      channel: "browser-input-test",
      initial: { status: "loading", message: "Loading", editable: false },
      arrayFields,
      actions,
    });
    await frame.getByRole("button").first().waitFor();
    await page.waitForFunction(() =>
      window.inputMessages.some((m) => m.event === "ready"),
    );
    await frame.locator("button:enabled").first().waitFor();
    return frame;
  };
  const submittedInput = async () => {
    await page.waitForFunction(() =>
      window.inputMessages.some((m) => m.event === "submit"),
    );
    return page.evaluate(
      () => window.inputMessages.find((m) => m.event === "submit").data,
    );
  };
  const choices =
    '<button name="choice" value="review">Review</button><button name="choice" value="run">Run</button>';
  inner = await loadInput(`<form data-vibe-form>${choices}</form>`);
  await inner.getByRole("button", { name: "Run", exact: true }).click();
  assert.deepEqual(await submittedInput(), { choice: "run" });
  inner = await loadInput(
    `<form data-vibe-form><input name="title">${choices}</form>`,
  );
  await inner.locator("input").fill("한글 초안");
  assert.equal(
    await page.evaluate(
      () => window.inputMessages.filter((m) => m.event === "submit").length,
    ),
    0,
  );
  await inner.locator("input").press("Enter");
  assert.deepEqual(await submittedInput(), {
    title: "한글 초안",
    choice: "review",
  });
  inner = await loadInput(
    `<form data-vibe-form><input name="elements" value="example">${choices}</form>`,
  );
  await inner.locator("input").press("Enter");
  assert.deepEqual(await submittedInput(), {
    elements: "example",
    choice: "review",
  });
  inner = await loadInput(
    '<form data-vibe-form><button name="choice" value="review">Review</button><input type="submit" name="choice" value="Run"></form>',
  );
  await inner.locator('input[type="submit"]').press("Enter");
  assert.deepEqual(await submittedInput(), { choice: "Run" });
  inner = await loadInput(
    '<form data-vibe-form><input name="title"><button disabled name="choice" value="blocked">Blocked</button><button type="button">Other</button></form>',
  );
  assert.equal(
    await inner
      .getByRole("button", { name: "Blocked", exact: true })
      .isDisabled(),
    true,
  );
  await inner.locator("input").press("Enter");
  assert.equal(
    await page.evaluate(
      () => window.inputMessages.filter((m) => m.event === "submit").length,
    ),
    0,
  );
  inner = await loadInput(
    '<form data-vibe-form><input name="title"><fieldset disabled><button name="choice" value="blocked">Blocked</button></fieldset><button type="button">Other</button></form>',
  );
  await inner.locator("input").press("Enter");
  assert.equal(
    await page.evaluate(
      () => window.inputMessages.filter((m) => m.event === "submit").length,
    ),
    0,
  );
  inner = await loadInput(
    '<form data-vibe-form><select name="choices" multiple><option value="a">A</option><option value="b">B</option></select><input type="number" name="count" value="3"><input type="checkbox" name="enabled" data-vibe-boolean><button>Submit</button></form>',
    ["choices"],
  );
  await inner.getByRole("button", { name: "Submit", exact: true }).click();
  assert.deepEqual(await submittedInput(), {
    choices: [],
    count: 3,
    enabled: false,
  });
  inner = await loadInput(
    '<form data-vibe-form><input type="number" name="counts" value="2"><input type="number" name="counts" value="3"><input name="mixed" value="text"><input type="number" name="mixed" value="4"><button>Submit</button></form>',
    ["counts", "mixed"],
  );
  await inner.getByRole("button", { name: "Submit", exact: true }).click();
  assert.deepEqual(await submittedInput(), {
    counts: [2, 3],
    mixed: ["text", 4],
  });
  inner = await loadInput(
    '<form data-vibe-form><input name="elements" value="example"><input name="reportValidity" value="valid"><input type="checkbox" name="disabled" data-vibe-boolean disabled checked><button>Submit</button></form>',
  );
  await inner.getByRole("button", { name: "Submit", exact: true }).click();
  assert.deepEqual(await submittedInput(), {
    elements: "example",
    reportValidity: "valid",
  });
  inner = await loadInput(
    '<button type="button" data-vibe-submit onclick="window.vibe.submit({choice: \'custom\'})">Custom</button>',
  );
  await inner.getByRole("button", { name: "Custom", exact: true }).click();
  assert.deepEqual(await submittedInput(), { choice: "custom" });
  inner = await loadInput(
    '<form data-vibe-form><button>Submit</button><button type="button" data-vibe-cancel>Cancel</button></form>',
  );
  await inner.locator("body").evaluate(() => {
    try {
      window.vibe.submit({ choice: "automatic" });
    } catch {
      /* Expected. */
    }
    document.querySelector("button").click();
    parent.postMessage(
      {
        type: "vibe:artifact:input",
        channel: "forged",
        event: "submit",
        data: {},
      },
      "*",
    );
  });
  assert.equal(
    await page.evaluate(
      () => window.inputMessages.filter((m) => m.event === "submit").length,
    ),
    0,
  );
  await inner.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForFunction(() =>
    window.inputMessages.some((m) => m.event === "cancel"),
  );
  assert.equal(
    await page.evaluate(
      () => window.inputMessages.filter((m) => m.event === "submit").length,
    ),
    0,
  );
  console.log(
    "Artifact input passed: named submit buttons, keyboard defaults, numbers/arrays/booleans, custom submit, gesture checks and cancellation.",
  );
  inner = await loadInput(
    '<form data-vibe-form><input name="title" oninput="this.form.querySelector(\'button\').disabled=!this.value"><button disabled>Submit</button><button type="button" data-vibe-cancel>Cancel</button></form>',
  );
  const updateState = async (editable = true) => {
    await page.evaluate((editable) => {
      document.querySelector("iframe").contentWindow.postMessage(
        {
          type: "vibe:artifact:state",
          channel: "browser-input-test",
          value: {
            status: "input_required",
            message: editable ? "Updated" : "Locked",
            editable,
          },
        },
        "*",
      );
    }, editable);
    await inner
      .getByText(editable ? "Updated" : "Locked", { exact: true })
      .waitFor();
  };
  await inner.locator("input").fill("Valid draft");
  await updateState();
  assert.equal(
    await inner
      .getByRole("button", { name: "Submit", exact: true })
      .isEnabled(),
    true,
  );
  await updateState(false);
  assert.equal(await inner.locator("input").isDisabled(), true);
  await updateState();
  assert.equal(
    await inner
      .getByRole("button", { name: "Submit", exact: true })
      .isEnabled(),
    true,
  );
  await updateState(false);
  await inner
    .locator("button")
    .first()
    .evaluate((button) => {
      button.disabled = true;
    });
  await updateState();
  assert.equal(await inner.locator("button").first().isDisabled(), true);
  await updateState(false);
  await inner
    .locator("button")
    .first()
    .evaluate((button) => {
      button.disabled = false;
    });
  await updateState();
  assert.equal(await inner.locator("button").first().isEnabled(), true);
  await inner.locator("input").fill("");
  await updateState();
  assert.equal(
    await inner
      .getByRole("button", { name: "Submit", exact: true })
      .isDisabled(),
    true,
  );
  console.log(
    "Dynamic validation passed: editable updates preserve both enabled and disabled controls, including lock/unlock recovery.",
  );
  await page.evaluate(() => {
    window.restoredDraft = [
      { index: 0, name: "title", value: "Restored draft" },
    ];
  });
  inner = await loadInput(
    '<form data-vibe-form><input name="title" oninput="this.form.querySelector(\'button\').disabled=!this.value"><button disabled>Submit</button><button type="button" data-vibe-cancel>Cancel</button></form>',
  );
  assert.equal(await inner.locator("input").inputValue(), "Restored draft");
  assert.equal(
    await inner
      .getByRole("button", { name: "Submit", exact: true })
      .isEnabled(),
    true,
  );
  await page.evaluate(() => {
    delete window.restoredDraft;
  });
  console.log(
    "Draft restoration passed: validation runs after host controls are unlocked.",
  );
  inner = await loadInput(
    '<form data-vibe-form><input name="title" value="Initial draft"><button disabled>Submit</button><button type="button" data-vibe-cancel>Cancel</button></form><script>addEventListener("DOMContentLoaded",()=>document.querySelector("button").disabled=false);</script>',
  );
  assert.equal(await inner.locator("button").first().isEnabled(), true);

  const rows = Array.from(
    { length: 200 },
    (_, index) =>
      `<label style="display:block;padding:18px 0"><input type="checkbox" name="choices" value="${index}">Synthetic choice ${index}</label>`,
  ).join("");
  inner = await loadInput(
    `<form data-vibe-form>${rows}<button>Submit</button></form>`,
    ["choices"],
  );
  await page.waitForFunction(
    () => document.querySelector("iframe").clientHeight === 10000,
  );
  assert.equal(
    await inner
      .locator("html")
      .evaluate((element) => getComputedStyle(element).overflowY),
    "auto",
  );
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.mouse.move(100, 200);
  await page.mouse.wheel(0, 20000);
  await page.waitForTimeout(250);
  assert.equal(
    await inner
      .locator("button")
      .evaluate(
        (element) => element.getBoundingClientRect().bottom <= innerHeight,
      ),
    true,
  );
  await inner.getByRole("button", { name: "Submit", exact: true }).click();
  assert.deepEqual(await submittedInput(), { choices: [] });
  await inner
    .locator("label")
    .evaluateAll((elements) =>
      elements.slice(2).forEach((element) => element.remove()),
    );
  await page.waitForFunction(
    () => document.querySelector("iframe").clientHeight < 10000,
  );
  assert.equal(
    await inner
      .locator("html")
      .evaluate((element) => getComputedStyle(element).overflowY),
    "clip",
  );
  console.log(
    "Oversized form passed: mouse scrolling reaches the submit button and compact layout returns after shrinkage.",
  );

  inner = await loadInput(
    '<form data-vibe-form><input name="title"><button data-vibe-cancel>Cancel</button></form>',
  );
  await inner.locator("input").press("Enter");
  await page.waitForFunction(() =>
    window.inputMessages.some((m) => ["cancel", "submit"].includes(m.event)),
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.inputMessages
        .filter((m) => ["cancel", "submit"].includes(m.event))
        .map((m) => m.event),
    ),
    ["cancel"],
  );
  inner = await loadInput(
    '<form data-vibe-form><input name="note"><button data-vibe-request="refresh">Refresh</button></form>',
    [],
    ["refresh"],
  );
  await inner.locator("input").press("Enter");
  await page.waitForFunction(() =>
    window.inputMessages.some((m) => ["request", "submit"].includes(m.event)),
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.inputMessages
        .filter((m) => ["request", "submit"].includes(m.event))
        .map((m) => m.event),
    ),
    ["request"],
  );
  inner = await loadInput(
    `<input name="note"><output id="count"></output>
    <button type="button" data-vibe-request="refresh" onclick="window.vibe.request('refresh', {count: 2})">Refresh</button>
    <script>addEventListener('vibe:data', event => document.getElementById('count').textContent = event.detail.data?.count ?? 'Waiting');</script>`,
    [],
    ["refresh"],
  );
  await inner.locator("input").fill("한글 초안");
  await inner.locator("button").evaluate((button) => {
    try {
      window.vibe.request("refresh", { count: 99 });
    } catch {
      /* A page script cannot dispatch without a real gesture. */
    }
    button.click();
  });
  assert.equal(
    await page.evaluate(
      () => window.inputMessages.filter((m) => m.event === "request").length,
    ),
    0,
  );
  await page.evaluate(() => {
    document.querySelector("iframe").contentWindow.postMessage(
      {
        type: "vibe:artifact:state",
        channel: "browser-input-test",
        value: {
          status: "input_required",
          message: "Ready",
          editable: true,
          data: { count: 7 },
          revision: 2,
          updatedAt: null,
        },
      },
      "*",
    );
  });
  await inner.locator("output").getByText("7", { exact: true }).waitFor();
  assert.equal(await inner.locator("input").inputValue(), "한글 초안");
  await inner.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() =>
    window.inputMessages.some((m) => m.event === "request"),
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.inputMessages
        .filter((m) => m.event === "request")
        .map((m) => m.data),
    ),
    [{ action: "refresh", data: { count: 2 } }],
  );
  console.log(
    "Automation bridge passed: live data preserves drafts and only a real click sends one registered action.",
  );
  for (const lostReply of [false, true]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ content: cards.outputFiles[0].text });
    await page
      .locator("#session-name")
      .getByText("Original session", { exact: true })
      .waitFor();
    const form = page
      .locator("figure")
      .frameLocator("iframe")
      .frameLocator("iframe");
    await form.locator("input:enabled").waitFor();
    await page.evaluate((value) => {
      window.loseRenameReply = value;
    }, lostReply);
    await form.getByRole("button", { name: "Rename", exact: true }).click();
    if (lostReply)
      await page
        .getByRole("button", { name: "artifacts.input.check", exact: true })
        .click();
    await page
      .locator("#session-name")
      .getByText("Updated session", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator("#other-session-name").innerText(),
      "Other session",
    );
    const requests = await page.evaluate(() => window.renameRequests);
    assert.equal(
      requests.filter(
        (path) => path.includes("/other-host/") && path.includes("/sessions?"),
      ).length,
      1,
    );
    assert.equal(
      requests.filter((path) => path.includes("/respond?")).length,
      1,
    );
    await form.locator("input:disabled").waitFor();
  }
  console.log(
    "Service rename passed: the bound session list refreshes on completion and status recovery, without refetching another host or resending input.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
