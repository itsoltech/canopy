import { expect, test } from "bun:test";
import {
  AgentTool,
  AgentToolResultSchema,
  InteractionResponseSchema,
  ThreadEventSchema,
  ThreadSpecSchema,
  type AgentToolCall,
  type AgentToolResult,
} from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDirs, waitForProcessStopped } from "@canopy/testing";
import { automationMcp } from "../local-automation.ts";
import { closeAcpResources } from "../acp/cleanup.ts";
import { GrokThreads } from "./threads.ts";
import { grokLaunch } from "./launch.ts";
import type { ResolvedProfile } from "../profiles.ts";

const temporary = tempDirs();
const fixture = join(import.meta.dir, "../../agent-tools-mcp/fixtures/server.ts");

const profile: ResolvedProfile = {
  kind: "native",
  id: "native",
  providers: ["grok"],
  env: {},
  runtime: {},
};

function descriptor(path: string) {
  return {
    name: "agent_browser",
    command: process.execPath,
    args: [fixture, path, "argument with spaces", "; literal $(argument)"],
  };
}

function events(path: string): { event: string; pid: number }[] {
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; pid: number });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }

  throw new Error("Automation fixture condition timed out");
}

function clientFor(bridge: NonNullable<ReturnType<typeof automationMcp>>) {
  const endpoint = bridge.servers[0]!;
  const client = new Client({ name: "Canopy Grok fixture", version: "1" });

  return {
    client,
    connect: () =>
      client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }),
      ),
  };
}

test("Grok cleanup waits for every resource and still reaches launch cleanup after a close error", async () => {
  const closed: string[] = [];

  await expect(
    closeAcpResources([
      async () => {
        closed.push("client");
        throw new Error("client close failed");
      },
      async () => {
        closed.push("automation");
      },
      () => {
        closed.push("launch");
      },
    ]),
  ).rejects.toThrow("client close failed");
  expect(closed).toEqual(["client", "automation", "launch"]);
});

test("Grok automation MCP uses the real HTTP SDK, stdio fixture and gateway authorization", async () => {
  const root = temporary("canopy-grok-automation-");
  const path = join(root, "events.jsonl");
  const turns = { current: "" };
  const authorized: AgentToolCall[] = [];
  const finished: string[] = [];
  let delayed: { promise: Promise<AgentToolResult>; resolve(result: AgentToolResult): void } | undefined;
  let revoked = false;
  let descriptorRequest: { tools: AgentTool[]; threadId: string } | undefined;

  const spec = create(ThreadSpecSchema, {
    threadId: "thread-automation",
    localMcpTools: [AgentTool.BROWSER],
  });

  const bridge = automationMcp(
    {
      localMcpServers: (tools, threadId) => {
        descriptorRequest = { tools: [...tools], threadId };

        return [descriptor(path)];
      },
      callTool: async (call, _signal, admitted) => {
        authorized.push(call);

        if (revoked) return create(AgentToolResultSchema, { content: "grant revoked", isError: true });
        const result = delayed ? await delayed.promise : create(AgentToolResultSchema, { content: "approved" });
        admitted?.(() => {
          finished.push(call.callId);
        });

        return result;
      },
    },
    spec,
    () => turns.current,
  )!;

  const { client, connect } = clientFor(bridge);

  try {
    await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["image", "echo", "wait", "oversized"]);
    expect(descriptorRequest).toEqual({ tools: [AgentTool.BROWSER], threadId: spec.threadId });

    await expect(client.callTool({ name: "echo", arguments: { phase: "inactive" } })).rejects.toThrow(
      "Local automation denied",
    );
    expect(authorized).toHaveLength(0);
    expect(events(path).filter((event) => event.event === "called")).toEqual([]);

    turns.current = "turn-1";
    const granted = await client.callTool({ name: "echo", arguments: { phase: "granted" } });
    expect(granted.isError ?? false).toBe(false);
    expect(finished).toEqual([authorized[0]!.callId]);
    const content = (granted as { content: { type: "text"; text: string }[] }).content;

    const payload = JSON.parse(content[0]!.text) as {
      name: string;
      args: string[];
      arguments: { phase: string };
      home: string;
      parentOnly: string;
      providerKeyPresent: boolean;
    };

    expect(payload).toMatchObject({
      name: "fixture",
      args: ["argument with spaces", "; literal $(argument)"],
      arguments: { phase: "granted" },
      home: process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
      parentOnly: "",
      providerKeyPresent: false,
    });
    expect(JSON.parse(authorized[0]!.argumentsJson)).toEqual({
      tool: AgentTool.BROWSER,
      name: "echo",
      arguments: JSON.stringify({ phase: "granted" }),
    });

    await until(() => events(path).some((event) => event.event === "called"));
    delayed = Promise.withResolvers<AgentToolResult>();
    const stale = client.callTool({ name: "echo", arguments: { phase: "stale" } });
    await until(() => authorized.length === 2);
    turns.current = "turn-2";
    delayed.resolve(create(AgentToolResultSchema, { content: "approved" }));
    await expect(stale).rejects.toThrow("Local automation denied");
    expect(finished).toEqual(authorized.map((call) => call.callId));
    expect(events(path).filter((event) => event.event === "called")).toHaveLength(1);

    delayed = undefined;
    revoked = true;
    await expect(client.callTool({ name: "echo", arguments: { phase: "revoked" } })).rejects.toThrow(
      "Local automation denied",
    );
    expect(finished).toHaveLength(2);
    expect(events(path).filter((event) => event.event === "called")).toHaveLength(1);
  } finally {
    await client.close();
    await bridge.close();
  }

  await waitForProcessStopped(events(path)[0]!.pid);
});

test("Grok launch allows exact local MCP prefixes while retaining bot restrictions", () => {
  const root = temporary("canopy-grok-launch-");
  const launch = grokLaunch({ dataDir: root, profile, linkDeviceLogin: false });

  const bot = grokLaunch({
    dataDir: root,
    profile,
    linkDeviceLogin: false,
    bot: { cwd: root, instructions: "fixture", sourceHome: root },
  });

  try {
    const config = readFileSync(join(launch.options.env!["GROK_HOME"]!, "config.toml"), "utf8");
    expect(config).toContain('"MCPTool(agent_browser__*)"');
    expect(config).toContain('"MCPTool(agent_desktop__*)"');
    expect(config).toContain('"MCPTool(agent_device__*)"');

    const botConfig = readFileSync(join(bot.options.env!["GROK_HOME"]!, "config.toml"), "utf8");
    expect(botConfig).not.toContain("agent_browser__");
    expect(botConfig).toContain('deny = ["Bash(*)","Read(*)","Write(*)","Edit(*)","Agent(*)"');
  } finally {
    launch.cleanup();
    bot.cleanup();
  }
});

test("Grok removes its process home when local automation setup fails", async () => {
  const root = temporary("canopy-grok-automation-failure-");

  const spec = create(ThreadSpecSchema, {
    threadId: "thread-automation-failure",
    cwd: root,
    localMcpTools: [AgentTool.BROWSER],
  });

  const threads = new GrokThreads({
    dataDir: root,
    executable: process.execPath,
    linkDeviceLogin: false,
    profile: () => profile,
    record: async () => create(ThreadEventSchema),
    interact: async () => create(InteractionResponseSchema, { allow: false }),
    callTool: async () => create(AgentToolResultSchema, { isError: true }),
    localMcpServers: () => [{ name: "invalid/name", command: process.execPath, args: [] }],
  });

  await expect(threads.create(spec)).rejects.toThrow("Invalid or duplicate local automation server name");
  expect(readdirSync(join(root, "grok", profile.id)).filter((name) => name.startsWith("process-"))).toEqual([]);
  await threads.close();
});
