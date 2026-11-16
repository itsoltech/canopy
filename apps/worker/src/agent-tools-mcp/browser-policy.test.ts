import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tempDirs } from "@canopy/testing";
import { z } from "zod";
import { createLocalAutomationMcp } from "./index.ts";

const temporary = tempDirs();
const session = "thread-browser-session";
const reply = z.object({ error: z.object({ code: z.number(), message: z.string() }) });
const toolReply = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
const forwarded = z.object({ arguments: z.record(z.string(), z.json()) });

function fixture() {
  const path = join(temporary("canopy-browser-mcp-policy-"), "events.jsonl");
  const authorized: string[] = [];

  const bridge = createLocalAutomationMcp({
    servers: [
      {
        name: "agent_browser",
        command: process.execPath,
        args: [join(import.meta.dir, "fixtures/server.ts"), path],
        env: { AGENT_BROWSER_SESSION: session },
      },
    ],
    env: { CANOPY_MCP_BROWSER_POLICY: "1" },
    authorize: async (_server, _tool, args) => {
      authorized.push(args);
    },
  });

  return { bridge, path, authorized, endpoint: bridge.servers[0]! };
}

test("browser MCP rejects foreign sessions and headed overrides before authorizing or starting stdio", async () => {
  const f = fixture();

  const invalid = [
    { session: "demo" },
    { session: 4 },
    { namespace: "demo" },
    { headed: true },
    { headed: "false" },
    { extraArgs: ["--session", "demo"] },
    { extraArgs: ["--session=demo"] },
    { extraArgs: ["--namespace", "demo"] },
    { extraArgs: ["--namespace=demo"] },
    { extraArgs: ["--headed"] },
    { extraArgs: ["--headed=true"] },
    { extraArgs: "--headed" },
  ];

  try {
    for (const args of invalid) {
      const response = await fetch(f.endpoint.url, {
        method: "POST",
        headers: f.endpoint.headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "agent_browser_open", arguments: args },
        }),
      });

      expect(reply.parse(await response.json()).error.code).toBe(-32602);
    }

    expect(f.authorized).toEqual([]);
    expect(existsSync(f.path)).toBe(false);
  } finally {
    await f.bridge.close();
  }
});

test("browser MCP catalog and SDK calls share the pinned session and explicit headless launch arguments", async () => {
  const f = fixture();
  const client = new Client({ name: "Canopy browser policy fixture", version: "1" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.endpoint.url), { requestInit: { headers: f.endpoint.headers } }),
    );
    const catalog = await client.listTools();

    for (const tool of catalog.tools) {
      expect(tool.inputSchema.properties?.["session"]).toMatchObject({ enum: [session] });
      expect(tool.description).toContain("thread's browser session");

      if (tool.name === "agent_browser_open" || tool.name === "agent_browser_doctor")
        expect(tool.inputSchema.properties?.["headed"]).toMatchObject({ enum: [false], default: false });
      else expect(tool.inputSchema.properties?.["headed"]).toBeUndefined();
    }

    const calls = [
      { name: "agent_browser_open", arguments: { url: "https://example.test/" } },
      { name: "agent_browser_snapshot", arguments: { headed: false } },
      { name: "agent_browser_tab_new", arguments: { session, namespace: "" } },
      { name: "agent_browser_doctor", arguments: { session: "", headed: false } },
      { name: "agent_browser_snapshot", arguments: { extraArgs: ["--debug"] } },
    ];

    const expected = [
      { url: "https://example.test/", session, headed: false },
      { session, extraArgs: ["--headed", "false"] },
      { session, namespace: "", extraArgs: ["--headed", "false"] },
      { session, headed: false },
      { extraArgs: ["--debug", "--headed", "false"], session },
    ];

    for (const [index, call] of calls.entries()) {
      const result = toolReply.parse(await client.callTool(call));
      const actual = forwarded.parse(JSON.parse(result.content[0]!.text));
      expect(actual.arguments).toEqual(expected[index]!);
      expect(JSON.parse(f.authorized[index]!)).toEqual(actual.arguments);
    }

    expect(
      readFileSync(f.path, "utf8")
        .split("\n")
        .filter((line) => line.includes('"event":"called"')),
    ).toHaveLength(calls.length);
  } finally {
    await client.close();
    await f.bridge.close();
  }
});
