import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  AgentTool,
  BrowserSessionDefaultsSchema,
  DesktopSessionDefaultsSchema,
  RunAgentToolSchema,
} from "@canopy/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PreviewRuntime } from "../agent-preview/runtime.ts";
import { defaultsFixture } from "./session-defaults.test-support.ts";
import type { LocalAutomationMcp } from "../agent-tools-mcp/index.ts";

async function connect(bridge: LocalAutomationMcp) {
  const client = new Client({ name: "Canopy session defaults fixture", version: "1" });
  const endpoint = bridge.servers[0];

  if (!endpoint) throw new Error("Missing automation endpoint");
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: endpoint.headers },
    }),
  );

  return client;
}

test("authorized browser calls initialize once and preserve session choices across bridge recreation", async () => {
  const f = await defaultsFixture();
  const bridge = f.bridge();
  const client = await connect(bridge);
  let second: LocalAutomationMcp | undefined;
  let secondClient: Client | undefined;

  try {
    await client.listTools();
    expect(f.events()).toEqual([]);
    expect(f.state().launched).toBe(false);
    f.deny(true);
    await expect(
      client.callTool({ name: "agent_browser_open", arguments: { url: "https://example.test" } }),
    ).rejects.toThrow("Local automation denied");
    expect(f.events().filter((event) => event.kind === "cli")).toHaveLength(0);
    f.deny(false);
    await client.callTool({ name: "agent_browser_doctor", arguments: {} });
    expect(f.state().launched).toBe(false);

    await Promise.all(
      [1, 2].map(() => client.callTool({ name: "agent_browser_open", arguments: { url: "https://example.test" } })),
    );
    const cli = f.events().filter((event) => event.kind === "cli");
    const initialized = cli.filter((event) => event.args?.includes("viewport"));
    expect(initialized).toHaveLength(1);
    expect(initialized[0]?.args).toEqual([
      "--json",
      "--session",
      f.spec.threadId,
      "--headed",
      "false",
      "--color-scheme",
      "dark",
      "set",
      "viewport",
      "1440",
      "900",
    ]);
    expect(f.events().findIndex((event) => event.kind === "authorized")).toBeLessThan(
      f.events().findIndex((event) => event.kind === "cli"),
    );
    expect(f.state()).toEqual({ launched: true, width: 1440, height: 900 });

    f.resize();
    await client.close();
    await bridge.close();
    second = f.bridge();
    secondClient = await connect(second);
    await secondClient.callTool({ name: "agent_browser_open", arguments: { url: "https://example.test/again" } });
    expect(f.state()).toEqual({ launched: true, width: 800, height: 600 });
    expect(f.events().filter((event) => event.args?.includes("viewport"))).toHaveLength(1);
  } finally {
    await client.close();
    await bridge.close();
    await secondClient?.close();
    await second?.close();
    await f.tools.close();
  }
});

test("Preview waits passively and applies browser defaults before explicit navigation", async () => {
  const f = await defaultsFixture();

  try {
    const resolved = await f.tools.resolvePreviewScope(
      create(RunAgentToolSchema, {
        tool: AgentTool.BROWSER,
        session: f.spec.threadId,
        operation: "screenshot",
      }),
      f.defaults,
    );

    const runtime = new PreviewRuntime(resolved, new AbortController().signal);
    await runtime.command(["session", "info"]);
    expect(f.state().launched).toBe(false);
    expect(f.events().filter((event) => event.args?.includes("viewport"))).toHaveLength(0);
    await runtime.command(["open", "https://example.test", "--headed", "false"]);
    expect(f.state()).toEqual({ launched: true, width: 1440, height: 900 });
    const cli = f.events().filter((event) => event.kind === "cli");
    expect(cli.findIndex((event) => event.args?.includes("viewport"))).toBeLessThan(
      cli.findIndex((event) => event.args?.includes("https://example.test")),
    );
    f.resize();
    await runtime.command(["open", "https://example.test/again"]);
    expect(f.state()).toEqual({ launched: true, width: 800, height: 600 });
  } finally {
    await f.tools.close();
  }
});

test("Desktop enables physical input only in an opted-in turn and still authorizes each click", async () => {
  const f = await defaultsFixture();
  const mouseClick = { name: "desktop_mouse_click", arguments: { xy: "10,20" } };
  f.spec.localMcpTools = [AgentTool.DESKTOP];

  try {
    for (const desktop of [{ app: "Editor" }, { allowPhysicalInput: true }, { allowPhysicalInput: false }]) {
      f.defaults.desktop = create(DesktopSessionDefaultsSchema, desktop);
      const { allowPhysicalInput } = f.defaults.desktop;
      const bridge = f.bridge();
      let client: Client | undefined;

      try {
        client = await connect(bridge);
        const { tools } = await client.listTools();
        const click = tools.find((tool) => tool.name === "desktop_click");
        const snapshot = tools.find((tool) => tool.name === "desktop_snapshot");
        expect(click?.description?.includes("can move the shared pointer")).toBe(allowPhysicalInput);
        expect(snapshot?.description?.includes("For background work")).toBe(!allowPhysicalInput);

        const before = f.mcpCalls();
        f.deny(true);
        await expect(client.callTool(mouseClick)).rejects.toThrow("Local automation denied");
        expect(f.mcpCalls()).toBe(before);
        f.deny(false);
        const result = await client.callTool(mouseClick);
        expect(f.mcpCalls()).toBe(before + 1);

        if (allowPhysicalInput) {
          expect(result.isError).toBe(false);
          expect(result.structuredContent).toMatchObject({
            ok: true,
            data: { steps: [{ mechanism: "physical_synthetic" }] },
          });
        } else {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            ok: false,
            command: "mouse-click",
            error: { code: "POLICY_DENIED", disposition: { delivery: "not_delivered" } },
          });
        }
      } finally {
        await client?.close();
        await bridge.close();
      }
    }
  } finally {
    await f.tools.close();
  }
});

test("empty and color-only browser defaults retain upstream viewport behavior", async () => {
  for (const colorScheme of ["", "no-preference"]) {
    const f = await defaultsFixture();

    try {
      f.defaults.browser = create(BrowserSessionDefaultsSchema, { colorScheme });
      const descriptor = f.tools.localMcpServers([AgentTool.BROWSER], f.spec.threadId, f.defaults)[0];

      if (!descriptor?.prepare) throw new Error("Missing browser initializer");
      await descriptor.prepare("agent_browser_open", new AbortController().signal);
      expect(f.state().launched).toBe(Boolean(colorScheme));
      const cli = f.events().filter((event) => event.kind === "cli");
      expect(cli).toHaveLength(colorScheme ? 2 : 0);
      expect(cli.some((event) => event.args?.includes("viewport"))).toBe(false);

      if (colorScheme) expect(cli[1]?.args).toContain("no-preference");
    } finally {
      await f.tools.close();
    }
  }
});
