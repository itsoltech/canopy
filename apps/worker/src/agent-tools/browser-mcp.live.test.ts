import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { AgentTool, ThreadSecretDeliverySchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalAutomationMcp } from "../agent-tools-mcp/index.ts";
import { ThreadSecretFiles } from "../runtime/thread-secrets.ts";
import { AgentTools } from "./index.ts";

const temporary = tempDirs();
const live = process.env["CANOPY_LIVE"] === "1";

test.skipIf(!live)(
  "Browser MCP resolves native dialogs and answers Basic Auth only for the requested origin",
  async () => {
    const cli = process.env["CANOPY_LIVE_BROWSER"] || Bun.which("agent-browser");

    if (!cli) throw new Error("Set CANOPY_LIVE_BROWSER to the pinned agent-browser executable");
    const dir = temporary("canopy-live-browser-");
    const threadId = crypto.randomUUID();
    const otherThread = crypto.randomUUID();
    const secretStore = new ThreadSecretFiles(dir);
    const env = { ...process.env, AGENT_BROWSER_NO_AUTO_DIALOG: "1" };

    const manager = new AgentTools({
      dataDir: dir,
      env,
      probe: { which: (name) => (name === "agent-browser" ? cli : null) },
      readManualSecret: (threadId, id) => secretStore.readManualSecret(threadId, id),
      send: () => {},
      progress: () => {},
    });

    const password = "fixture:password";
    const expectedAuth = `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`;

    const challenge = () =>
      new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Local fixture"' },
      });

    let foreignRequests = 0;
    let foreignCredential = false;
    let accepted = 0;

    const foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        foreignRequests++;
        foreignCredential ||= request.headers.has("authorization");

        return challenge();
      },
    });

    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);

        if (pathname === "/redirect") return Response.redirect(foreign.url.href);

        if (pathname === "/locked") {
          if (request.headers.get("authorization") !== expectedAuth) return challenge();
          accepted++;

          return new Response("<title>Protected page</title>", { headers: { "Content-Type": "text/html" } });
        }

        return new Response(
          `
      <script>document.title = confirm("Continue loading?") ? "accepted" : "dismissed";</script>
      <button id="alert" onclick="alert('Notice'); document.title = 'alert completed'">Alert</button>
      <button id="prompt" onclick="document.title = prompt('What is your name?', 'Default name')">Prompt</button>
      <button id="guard" onclick="window.onbeforeunload = () => true">Guard navigation</button>
    `,
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });

    const store = (owner: string, value: string) => {
      const requestId = crypto.randomUUID();

      const receipt = secretStore.apply(
        create(ThreadSecretDeliverySchema, {
          threadId: owner,
          requestId,
          value: JSON.stringify({ username: "fixture", password: value }),
          revision: 1,
          cwd: import.meta.dir,
          expiresAt: timestampFromDate(new Date(Date.now() + 120_000)),
        }),
      );

      expect(receipt.applied).toBe(true);

      return requestId;
    };

    const requestId = store(threadId, password);
    const wrongId = store(threadId, "wrong fixture value");
    const foreignId = store(otherThread, password);
    let bridge: ReturnType<typeof createLocalAutomationMcp> | undefined;
    const client = new Client({ name: "Canopy browser fixture", version: "1" });

    try {
      const report = await manager.probe();
      const servers = manager.localMcpServers([AgentTool.BROWSER], threadId);

      if (!servers.length)
        throw new Error(
          report.tools?.find(({ tool }) => tool === AgentTool.BROWSER)?.detail || "Browser runtime unavailable",
        );
      const authorized: string[] = [];
      bridge = createLocalAutomationMcp({
        servers,
        env,
        authorize: async (_server, _name, args) => {
          authorized.push(args);
        },
      });
      const { url, headers } = bridge.servers[0]!;
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));

      const call = async (name: string, args = {}) => {
        try {
          return await client.callTool({ name: `agent_browser_${name}`, arguments: args }, undefined, {
            timeout: 6_000,
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "Unknown MCP error";

          throw new Error(`${name}: ${message}`);
        }
      };

      const basic = (url: string, requestId: string) => call("open_with_basic_auth", { url, requestId });

      const title = async (expected: string) => {
        const result = await call("get_title");
        expect(result.structuredContent).toMatchObject({ response: { data: { title: expected } } });
      };

      const catalog = await client.listTools();
      expect(catalog.tools.map(({ name }) => name)).toContain("agent_browser_dialog_status");
      expect(catalog.tools.map(({ name }) => name)).toContain("agent_browser_open_with_basic_auth");

      const navigation = await call("open", { url: site.url.href });
      expect(navigation.structuredContent).toMatchObject({ dialog: { type: "confirm", message: "Continue loading?" } });
      expect((await call("dialog_status")).structuredContent).toMatchObject({
        response: { data: { hasDialog: true, type: "confirm" } },
      });
      expect((await call("dialog_dismiss")).isError).toBeFalsy();
      await title("dismissed");
      expect((await call("click", { selector: "#alert" })).isError).toBeFalsy();
      expect((await call("dialog_status")).structuredContent).toMatchObject({
        response: { data: { type: "alert", message: "Notice" } },
      });
      expect((await call("dialog_accept")).isError).toBeFalsy();
      await title("alert completed");
      expect((await call("click", { selector: "#prompt" })).isError).toBeFalsy();
      expect((await call("dialog_status")).structuredContent).toMatchObject({
        response: { data: { type: "prompt", defaultPrompt: "Default name" } },
      });
      expect((await call("dialog_accept", { text: "Name from MCP" })).isError).toBeFalsy();
      await title("Name from MCP");

      const locked = new URL("/locked", site.url).href;
      expect((await call("click", { selector: "#guard" })).isError).toBeFalsy();
      expect((await call("open", { url: locked })).structuredContent).toMatchObject({
        dialog: { type: "beforeunload" },
      });
      expect((await call("dialog_dismiss")).isError).toBeFalsy();
      await title("Name from MCP");
      expect((await call("eval", { script: "window.onbeforeunload = null" })).isError).toBeFalsy();

      const credentialUrl = new URL(locked);
      credentialUrl.password = password;
      const beforeInvalid = authorized.length;
      await expect(basic(credentialUrl.href, requestId)).rejects.toThrow("without credentials");
      expect(authorized).toHaveLength(beforeInvalid);
      expect((await call("open", { url: locked })).content).toMatchObject([
        { text: expect.stringContaining("agent_browser_open_with_basic_auth") },
      ]);
      expect((await basic(locked, foreignId)).isError).toBe(true);
      expect(await basic(locked, wrongId)).toMatchObject({
        isError: true,
        content: [{ text: "The server rejected the Basic Auth credentials." }],
      });
      expect((await basic(new URL("/redirect", site.url).href, requestId)).isError).toBe(true);
      expect(foreignRequests).toBeGreaterThan(0);
      expect(foreignCredential).toBe(false);
      expect((await basic(locked, requestId)).isError).toBeFalsy();
      expect(accepted).toBeGreaterThan(0);
      await title("Protected page");
      expect(authorized.join("\n")).not.toContain(password);
    } finally {
      await client.close();
      await bridge?.close();
      const session = manager.localMcpServers([AgentTool.BROWSER], threadId)[0]?.scope?.session;

      if (session) {
        const child = Bun.spawn([cli, "--session", session, "close"], {
          env,
          stdout: "ignore",
          stderr: "ignore",
          timeout: 8_000,
        });

        await child.exited;
      }

      await site.stop(true);
      await foreign.stop(true);
      secretStore.close();
    }
  },
  30_000,
);
