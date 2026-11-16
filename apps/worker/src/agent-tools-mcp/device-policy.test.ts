import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tempDirs } from "@canopy/testing";
import { z } from "zod";
import { AgentTool } from "@canopy/contracts";
import { createLocalAutomationMcp } from "./index.ts";

const temporary = tempDirs();
const session = "01a1e5eb-13fe-72e7-b7b9-63e115fab278";
const reply = z.object({ error: z.object({ code: z.number(), message: z.string() }) });
const toolReply = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
const forwarded = z.object({ arguments: z.record(z.string(), z.json()), deviceSession: z.string() });

function fixture() {
  const path = join(temporary("canopy-device-mcp-policy-"), "events.jsonl");
  const authorized: string[] = [];

  const bridge = createLocalAutomationMcp({
    servers: [
      {
        name: "agent_device",
        command: process.execPath,
        args: [join(import.meta.dir, "fixtures/server.ts"), path],
        env: { AGENT_DEVICE_SESSION: session },
        scope: { tool: AgentTool.DEVICE, session },
      },
    ],
    env: { CANOPY_MCP_DEVICE_POLICY: "1" },
    authorize: async (_server, _tool, args) => {
      authorized.push(args);
    },
  });

  // SAFETY: the bridge creates one endpoint for the single fixture descriptor.
  return { bridge, path, authorized, endpoint: bridge.servers[0]! };
}

test("device MCP rejects foreign sessions before authorization or starting automation, including batch steps", async () => {
  const f = fixture();

  const calls = [
    { name: "boot", arguments: { platform: "android", session: "composer-gap" } },
    { name: "open", arguments: { app: "tech.itsol.canopy_remote", session: "composer-gap" } },
    { name: "snapshot", arguments: { session: 4 } },
    { name: "close", arguments: { session: null } },
    { name: "test", arguments: { paths: ["suite.ad"] } },
    { name: "batch", arguments: { steps: [{ command: "test", input: { paths: ["suite.ad"] } }] } },
    {
      name: "batch",
      arguments: { steps: [{ command: "open", input: { session: "composer-gap" } }] },
    },
    {
      name: "batch",
      arguments: { steps: [{ command: "snapshot", input: { session: false } }] },
    },
  ];

  try {
    for (const params of calls) {
      const response = await fetch(f.endpoint.url, {
        method: "POST",
        headers: f.endpoint.headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
      });

      expect(reply.parse(await response.json()).error.code).toBe(-32602);
    }

    expect(f.authorized).toEqual([]);
    expect(existsSync(f.path)).toBe(false);
  } finally {
    await f.bridge.close();
  }
});

test("device MCP catalog and calls bind the agent workflow to the Preview session and preserve device selection", async () => {
  const f = fixture();
  const client = new Client({ name: "Canopy device policy fixture", version: "1" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.endpoint.url), { requestInit: { headers: f.endpoint.headers } }),
    );
    const catalog = await client.listTools();
    expect(catalog.tools.some((tool) => tool.name === "test")).toBe(false);
    expect(catalog.tools.find((tool) => tool.name === "replay")?.description).toContain("Use replay for each script");

    for (const tool of catalog.tools) {
      expect(tool.inputSchema.properties?.["session"]).toMatchObject({ enum: [session] });
      expect(tool.description).toContain("Preview share this thread's fixed session");
    }

    const calls = [
      { name: "devices", arguments: {} },
      { name: "boot", arguments: { platform: "android", device: "canopy_test", headless: true } },
      { name: "apps", arguments: { session: "", platform: "android" } },
      { name: "open", arguments: { session, app: "tech.itsol.canopy_remote", serial: "emulator-5554" } },
      { name: "snapshot", arguments: {} },
      { name: "screenshot", arguments: { path: "/tmp/frame.png" } },
      { name: "close", arguments: { shutdown: true } },
      { name: "replay", arguments: { path: "suite.ad", keepSession: true } },
    ];

    for (const [index, call] of calls.entries()) {
      const result = toolReply.parse(await client.callTool(call));
      // SAFETY: the fixture always returns one text content block containing the forwarded call.
      const actual = forwarded.parse(JSON.parse(result.content[0]!.text));
      expect(actual.arguments).toEqual({ ...call.arguments, session });
      expect(actual.deviceSession).toBe(session);
      // SAFETY: authorization completes before this tool response is produced.
      expect(JSON.parse(f.authorized[index]!)).toEqual(actual.arguments);
    }

    const steps = [
      { command: "open", input: { app: "Settings", platform: "ios", udid: "simulator-id" } },
      { command: "snapshot", input: { session: "", interactive: true } },
      { command: "close", input: { session }, runtime: { timeoutMs: 1000 } },
    ];

    const result = toolReply.parse(await client.callTool({ name: "batch", arguments: { steps, onError: "stop" } }));
    // SAFETY: the fixture always returns one text content block containing the forwarded call.
    const actual = forwarded.parse(JSON.parse(result.content[0]!.text));
    expect(actual.arguments).toEqual({
      session,
      onError: "stop",
      steps: steps.map((step) => ({ ...step, input: { ...step.input, session } })),
    });
    // SAFETY: authorization completes before this tool response is produced.
    expect(JSON.parse(f.authorized[calls.length]!)).toEqual(actual.arguments);
  } finally {
    await client.close();
    await f.bridge.close();
  }
});
