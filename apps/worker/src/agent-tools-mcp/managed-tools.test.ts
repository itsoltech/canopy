import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentTool } from "@canopy/contracts";
import { tempDirs, waitForProcessStopped } from "@canopy/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createLocalAutomationMcp,
  type LocalAutomationMcp,
  type LocalAutomationMcpOptions,
  type LocalAutomationServer,
} from "./index.ts";
import type { Rpc } from "./protocol.ts";
import type { AutomationCall } from "./session-policy.ts";

const temporary = tempDirs();
const session = "managed-device-thread";
const Event = z.object({ event: z.string(), pid: z.number() });
const RpcReply = z.object({ error: z.object({ code: z.number(), message: z.string() }).optional() });
const TextReply = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
const Forwarded = z.object({ arguments: z.record(z.string(), z.json()) });

const managedTools: Tool[] = [
  { name: "boot", description: "Managed boot", inputSchema: { type: "object" } },
  { name: "managed_wait", description: "Wait for a managed device", inputSchema: { type: "object" } },
];

function fixture(
  managed: NonNullable<LocalAutomationServer["managed"]>,
  authorize: LocalAutomationMcpOptions["authorize"],
) {
  const path = join(temporary("canopy-managed-mcp-"), "events.jsonl");

  const bridge = createLocalAutomationMcp({
    servers: [
      {
        name: "agent_device",
        command: process.execPath,
        args: [join(import.meta.dir, "fixtures/server.ts"), path],
        scope: { tool: AgentTool.DEVICE, session },
        managed,
      },
    ],
    env: { CANOPY_MCP_DEVICE_POLICY: "1" },
    authorize,
  });

  return { bridge, path };
}

function events(path: string) {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => Event.parse(JSON.parse(line)))
    : [];
}

function send(bridge: LocalAutomationMcp, rpc: Omit<Rpc, "jsonrpc">) {
  // SAFETY: the fixture has exactly one server descriptor.
  const endpoint = bridge.servers[0]!;

  return fetch(endpoint.url, {
    method: "POST",
    headers: endpoint.headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...rpc }),
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }

  throw new Error("Managed tool condition timed out");
}

test("managed tools extend the policy catalog and wrap upstream calls without forwarding custom or unknown tools", async () => {
  const calls: AutomationCall[] = [];
  const authorized: string[] = [];
  const managedResult: CallToolResult = { content: [{ type: "text", text: "Managed device ready" }] };

  const f = fixture(
    {
      tools: managedTools,
      async call(params, signal, next) {
        calls.push(params);

        if (params.name === "managed_wait") {
          expect(await next(params, signal)).toBeUndefined();

          return managedResult;
        }

        return next(params, signal);
      },
    },
    async (_server, tool) => {
      authorized.push(tool);
    },
  );

  const client = new Client({ name: "Canopy managed fixture", version: "1" });

  try {
    // SAFETY: the fixture has exactly one server descriptor.
    const endpoint = f.bridge.servers[0]!;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }),
    );
    const catalog = await client.listTools();
    expect(catalog.tools.filter((tool) => tool.name === "boot")).toEqual([managedTools[0]!]);
    expect(catalog.tools.at(-1)).toEqual(managedTools[1]!);
    expect(catalog.tools.some((tool) => tool.name === "test")).toBe(false);
    expect(catalog.tools.find((tool) => tool.name === "snapshot")?.description).toContain("fixed session");
    expect(await client.callTool({ name: "managed_wait" })).toEqual(managedResult);
    expect(events(f.path).filter((event) => event.event === "called")).toEqual([]);

    for (const name of ["boot", "snapshot"]) {
      const result = TextReply.parse(await client.callTool({ name, arguments: { platform: "android" } }));
      // SAFETY: the fixture always returns one text block for these tools.
      expect(Forwarded.parse(JSON.parse(result.content[0]!.text)).arguments).toEqual({ platform: "android", session });
    }

    const response = await send(f.bridge, { id: "unknown", method: "tools/call", params: { name: "unknown" } });
    expect(RpcReply.parse(await response.json()).error?.code).toBe(-32601);
    expect(calls.map((call) => call.name)).toEqual(["managed_wait", "boot", "snapshot", "unknown"]);
    expect(authorized).toEqual(calls.map((call) => call.name));
    expect(events(f.path).filter((event) => event.event === "called")).toHaveLength(2);
  } finally {
    await client.close();
    await f.bridge.close();
  }
});

test("managed handlers start only after session policy and current authorization permit the call", async () => {
  const allowed = Promise.withResolvers<void>();
  const calls: AutomationCall[] = [];
  let authorizations = 0;
  let deny = true;

  const f = fixture(
    {
      tools: managedTools,
      async call(params) {
        calls.push(params);

        return { content: [] };
      },
    },
    async () => {
      authorizations++;

      if (deny) throw new Error("Denied");
      await allowed.promise;
    },
  );

  try {
    const foreign = await send(f.bridge, {
      id: "foreign",
      method: "tools/call",
      params: { name: "managed_wait", arguments: { session: "other-thread" } },
    });

    expect(RpcReply.parse(await foreign.json()).error?.code).toBe(-32602);
    expect(authorizations).toBe(0);
    const denied = await send(f.bridge, { id: "denied", method: "tools/call", params: { name: "managed_wait" } });
    expect(RpcReply.parse(await denied.json()).error?.code).toBe(-32001);
    expect(calls).toEqual([]);
    expect(events(f.path)).toEqual([]);
    deny = false;
    const pending = send(f.bridge, { id: "allowed", method: "tools/call", params: { name: "managed_wait" } });
    await until(() => authorizations === 2);
    expect(calls).toEqual([]);
    allowed.resolve();
    expect(RpcReply.parse(await (await pending).json()).error).toBeUndefined();
    expect(calls).toEqual([{ name: "managed_wait", arguments: { session } }]);
    expect(events(f.path)).toEqual([]);
  } finally {
    allowed.resolve();
    await f.bridge.close();
  }
});

test("MCP cancellation and bridge close abort managed waits even when a handler ignores its signal", async () => {
  const signals: AbortSignal[] = [];

  const f = fixture(
    {
      tools: managedTools,
      async call(_params, signal) {
        signals.push(signal);
        await new Promise<void>(() => {});

        return undefined;
      },
    },
    async () => {},
  );

  try {
    await send(f.bridge, { id: "catalog", method: "tools/list" });
    const pending = send(f.bridge, { id: "cancel", method: "tools/call", params: { name: "managed_wait" } });
    await until(() => signals.length === 1);
    const cancelled = await send(f.bridge, { method: "notifications/cancelled", params: { requestId: "cancel" } });
    expect(cancelled.status).toBe(202);
    expect(RpcReply.parse(await (await pending).json()).error?.message).toContain("cancelled");
    expect(signals[0]?.aborted).toBe(true);

    const closing = send(f.bridge, { id: "close", method: "tools/call", params: { name: "managed_wait" } }).catch(
      () => undefined,
    );

    await until(() => signals.length === 2);
    await f.bridge.close();
    await closing;
    expect(signals[1]?.aborted).toBe(true);
    expect(events(f.path).filter((event) => event.event === "called")).toEqual([]);
    // SAFETY: tools/list started the fixture before bridge.close terminated it.
    await waitForProcessStopped(events(f.path)[0]!.pid);
  } finally {
    await f.bridge.close();
  }
});
