import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentTool, AgentToolSessionDefaultsSchema } from "@canopy/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tempDirs } from "@canopy/testing";
import { z } from "zod";
import { createLocalAutomationMcp } from "./index.ts";
import type { AutomationCall } from "./session-policy.ts";

const temporary = tempDirs();
const session = "thread-desktop-session";
const rpcError = z.object({ error: z.object({ code: z.number() }) });
const toolReply = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
const forwarded = z.object({ arguments: z.record(z.string(), z.json()), args: z.array(z.string()) });

function fixture(app?: string) {
  const path = join(temporary("canopy-desktop-mcp-policy-"), "events.jsonl");
  const authorized: string[] = [];

  const bridge = createLocalAutomationMcp({
    servers: [
      {
        name: "agent_desktop",
        command: process.execPath,
        args: [join(import.meta.dir, "fixtures/server.ts"), path, "--session", session, "mcp"],
        scope: {
          tool: AgentTool.DESKTOP,
          session,
          ...(app && { defaults: create(AgentToolSessionDefaultsSchema, { desktop: { app } }) }),
        },
      },
    ],
    env: { CANOPY_MCP_DESKTOP_POLICY: "1" },
    authorize: async (_server, _tool, args) => {
      authorized.push(args);
    },
  });

  // SAFETY: the bridge creates one endpoint for the single fixture descriptor.
  return { bridge, path, authorized, endpoint: bridge.servers[0]! };
}

test("desktop rejects foreign sessions, session creation, global cleanup and sandbox execution before automation", async () => {
  const f = fixture();

  const calls: AutomationCall[] = [
    { name: "desktop_snapshot", arguments: { session: "other-thread" } },
    { name: "desktop_snapshot", arguments: { session: 1 } },
    { name: "desktop_session_start", arguments: { name: session } },
    { name: "desktop_session_gc", arguments: {} },
    { name: "desktop_sandbox_exec", arguments: { name: "guest", args: ["snapshot"] } },
    { name: "desktop_session_end", arguments: { id: "other-thread" } },
  ];

  for (const command of [
    { command: "snapshot", session: "other-thread", args: { app: "Editor" } },
    { command: "snapshot", session: null },
    { command: "session", args: { action: "start", name: session } },
    { command: "session", args: { action: "gc", ended: true } },
    { command: "session", args: { action: "end", id: "other-thread" } },
    { command: "sandbox", args: { action: "exec", name: "guest" } },
  ])
    calls.push({ name: "desktop_batch", arguments: { commands_json: JSON.stringify([command]) } });

  calls.push({ name: "desktop_batch", arguments: { commands_json: "invalid json" } });

  try {
    for (const params of calls) {
      const response = await fetch(f.endpoint.url, {
        method: "POST",
        headers: f.endpoint.headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
      });

      expect(rpcError.parse(await response.json()).error.code).toBe(-32602);
    }

    expect(f.authorized).toEqual([]);
    expect(existsSync(f.path)).toBe(false);
  } finally {
    await f.bridge.close();
  }
});

test("desktop keeps startup session and batch scope aligned without unsupported top-level MCP arguments", async () => {
  const f = fixture();
  const client = new Client({ name: "Canopy desktop policy fixture", version: "1" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.endpoint.url), { requestInit: { headers: f.endpoint.headers } }),
    );
    const catalog = await client.listTools();

    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "desktop_snapshot",
      "desktop_screenshot",
      "desktop_click",
      "desktop_batch",
      "desktop_session_end",
    ]);

    for (const tool of catalog.tools) {
      expect(tool.inputSchema.properties?.["session"]).toBeUndefined();
      expect(tool.description).toContain("Preview share this thread's fixed session");
    }

    expect(
      catalog.tools.find((tool) => tool.name === "desktop_session_end")?.inputSchema.properties?.["id"],
    ).toMatchObject({
      enum: [session],
    });

    const commands = [
      { command: "snapshot", args: { app: "Editor", window_id: "window-1" } },
      { command: "click", session: "", args: { ref_id: "@snapshot:e1" } },
      { command: "session", session, args: { action: "end" } },
    ];

    const calls = [
      { name: "desktop_snapshot", arguments: { app: "Editor", window_id: "window-1" } },
      { name: "desktop_click", arguments: { session, ref_id: "@snapshot:e1" } },
      { name: "desktop_batch", arguments: { commands_json: JSON.stringify(commands), stop_on_error: true } },
      { name: "desktop_session_end", arguments: {} },
    ];

    const expected = [
      calls[0]?.arguments,
      { ref_id: "@snapshot:e1" },
      {
        stop_on_error: true,
        commands_json: JSON.stringify(
          commands.map((command) => ({
            command: command.command,
            args: command.command === "session" ? { ...command.args, id: session } : command.args,
            session,
          })),
        ),
      },
      { id: session },
    ];

    for (const [index, call] of calls.entries()) {
      const result = toolReply.parse(await client.callTool(call));
      // SAFETY: the fixture always returns one text content block with the forwarded call.
      const actual = forwarded.parse(JSON.parse(result.content[0]!.text));
      expect(actual.args).toEqual(["--session", session, "mcp"]);
      // SAFETY: each call has a corresponding expected argument object at the same index.
      expect(actual.arguments).toEqual(expected[index]!);
      // SAFETY: authorization finishes before the fixture returns this call's response.
      expect(JSON.parse(f.authorized[index]!)).toEqual(actual.arguments);
    }
  } finally {
    await client.close();
    await f.bridge.close();
  }
});

test("desktop defaults only target app-aware tools and preserve explicit app, window and reference choices", async () => {
  const f = fixture("Preferred Editor");
  const client = new Client({ name: "Canopy desktop defaults fixture", version: "1" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.endpoint.url), { requestInit: { headers: f.endpoint.headers } }),
    );

    const calls: AutomationCall[] = [
      { name: "desktop_snapshot", arguments: {} },
      { name: "desktop_screenshot", arguments: { app: "Another Editor" } },
      { name: "desktop_click", arguments: { window_id: "chosen-window" } },
      { name: "desktop_click", arguments: { ref_id: "@chosen-window:e1" } },
      { name: "desktop_session_end", arguments: {} },
    ];

    const expected = [
      { app: "Preferred Editor" },
      { app: "Another Editor" },
      { window_id: "chosen-window" },
      { ref_id: "@chosen-window:e1" },
      { id: session },
    ];

    for (const [index, call] of calls.entries()) {
      const result = toolReply.parse(await client.callTool(call));
      // SAFETY: the fixture returns exactly one text block for each forwarded call.
      const actual = forwarded.parse(JSON.parse(result.content[0]!.text));
      // SAFETY: each fixture call has a corresponding expected object.
      expect(actual.arguments).toEqual(expected[index]!);
      // SAFETY: the authorization hook records the call before the response resolves.
      expect(JSON.parse(f.authorized[index]!)).toEqual(actual.arguments);
    }
  } finally {
    await client.close();
    await f.bridge.close();
  }
});
