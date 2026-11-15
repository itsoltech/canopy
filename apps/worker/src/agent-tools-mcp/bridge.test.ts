import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tempDirs, waitForProcessStopped } from "@canopy/testing";
import { z } from "zod";
import { createLocalAutomationMcp, type LocalAutomationMcp } from "./index.ts";
import { MAX_BYTES, MAX_PENDING, readRequest, requestDeadline } from "./protocol.ts";

const temporary = tempDirs();
const fixture = join(import.meta.dir, "fixtures/server.ts");
const Event = z.object({ event: z.string(), id: z.union([z.string(), z.number()]), pid: z.number() });

const RpcReply = z.object({
  result: z.json().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const descriptor = (name: string, path: string) => ({
  name,
  command: process.execPath,
  args: [fixture, path, "argument with spaces", "; literal $(argument)"],
});

function events(path: string) {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => Event.parse(JSON.parse(line)))
    : [];
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }

  throw new Error("Fixture condition timed out");
}

function send(bridge: LocalAutomationMcp, method: string, id: string | number | undefined = 1, params = {}, index = 0) {
  const endpoint = bridge.servers[index]!;

  return fetch(endpoint.url, {
    method: "POST",
    headers: endpoint.headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: method.startsWith("notifications/") ? undefined : id, method, params }),
  });
}

test("local MCP lazily starts exact argv with isolated env and preserves image content over Streamable HTTP", async () => {
  const path = join(temporary("canopy-local-mcp-"), "events.jsonl");
  const authorized: string[] = [];
  const parentOnly = process.env["CANOPY_MCP_PARENT_ONLY"];
  process.env["CANOPY_MCP_PARENT_ONLY"] = "must stay in parent";

  const bridge = createLocalAutomationMcp({
    servers: [descriptor("browser", path)],
    env: { CANOPY_MCP_FIXTURE: "browser" },
    authorize: async (name, toolName, argsJson) => {
      authorized.push(`${name}/${toolName}/${argsJson}`);
    },
  });

  const client = new Client({ name: "Canopy fixture", version: "1" });

  try {
    expect(events(path)).toEqual([]);
    expect((await send(bridge, "ping")).status).toBe(200);
    expect(events(path)).toEqual([]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.servers[0]!.url), {
        requestInit: { headers: bridge.servers[0]!.headers },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["image", "echo", "wait", "oversized"]);
    expect(await client.callTool({ name: "image", arguments: { caption: "visible" } })).toEqual({
      content: [
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "text", text: "browser" },
      ],
      _meta: { fixture: "browser" },
    });
    const echo = await client.callTool({ name: "echo", arguments: { nested: { value: 3 } } });
    const text = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) }).parse(echo);
    expect(JSON.parse(text.content[0]!.text)).toEqual({
      name: "browser",
      args: ["argument with spaces", "; literal $(argument)"],
      arguments: { nested: { value: 3 } },
      parentOnly: "",
      home: "",
      providerKeyPresent: false,
      browserSession: "",
      deviceSession: "",
    });
    expect(authorized).toEqual(['browser/image/{"caption":"visible"}', 'browser/echo/{"nested":{"value":3}}']);
    expect(events(path).filter((event) => event.event === "started")).toHaveLength(1);
  } finally {
    await client.close();
    await bridge.close();

    if (parentOnly === undefined) delete process.env["CANOPY_MCP_PARENT_ONLY"];
    else process.env["CANOPY_MCP_PARENT_ONLY"] = parentOnly;
  }

  await waitForProcessStopped(events(path)[0]!.pid);
});

test("local MCP rejects unauthenticated, unknown and revoked calls before invoking automation", async () => {
  const path = join(temporary("canopy-local-mcp-policy-"), "events.jsonl");
  let activeTurn = false;
  let authorized = 0;

  const bridge = createLocalAutomationMcp({
    servers: [descriptor("desktop", path)],
    env: {},
    authorize: async () => {
      authorized++;

      if (!activeTurn) throw new Error("Sensitive authorization failure");
    },
  });

  try {
    const endpoint = bridge.servers[0]!;
    expect((await fetch(endpoint.url, { method: "POST" })).status).toBe(401);
    expect((await fetch(endpoint.url, { headers: endpoint.headers })).status).toBe(405);
    expect((await fetch(endpoint.url.replace("desktop", "missing"), { headers: endpoint.headers })).status).toBe(401);
    expect(RpcReply.parse(await (await send(bridge, "resources/list")).json()).error?.code).toBe(-32601);
    expect(RpcReply.parse(await (await send(bridge, "tools/call", 2, { name: "echo" })).json()).error).toEqual({
      code: -32001,
      message: "Local automation denied",
    });
    expect(events(path)).toEqual([]);
    activeTurn = true;
    expect(RpcReply.parse(await (await send(bridge, "tools/call", 3, { name: "echo" })).json()).result).toBeDefined();
    expect(RpcReply.parse(await (await send(bridge, "tools/call", 4, { name: "unknown" })).json()).error?.code).toBe(
      -32601,
    );
    activeTurn = false;
    expect(RpcReply.parse(await (await send(bridge, "tools/call", 5, { name: "echo" })).json()).error?.code).toBe(
      -32001,
    );
    expect(authorized).toBe(4);
    expect(events(path).filter((event) => event.event === "called")).toHaveLength(1);
  } finally {
    await bridge.close();
  }
});

test("local MCP cancellation reaches stdio, aborts authorization, and close stops pending children", async () => {
  const path = join(temporary("canopy-local-mcp-cancel-"), "events.jsonl");
  let waitingForAuthorization = false;
  let authorizationSignal: AbortSignal | undefined;

  const bridge = createLocalAutomationMcp({
    servers: [descriptor("device", path)],
    env: {},
    authorize: async (_name, toolName, _argsJson, signal) => {
      if (toolName !== "blocked") return;
      waitingForAuthorization = true;
      authorizationSignal = signal;
      await new Promise<void>(() => {});
    },
  });

  try {
    const blocked = send(bridge, "tools/call", "auth", { name: "blocked" });
    await until(() => waitingForAuthorization);
    expect((await send(bridge, "notifications/cancelled", undefined, { requestId: "auth" })).status).toBe(202);
    expect(RpcReply.parse(await (await blocked).json()).error?.message).toContain("cancelled");
    expect(authorizationSignal?.aborted).toBe(true);
    expect(events(path)).toEqual([]);
    const pending = send(bridge, "tools/call", "wait", { name: "wait" });
    await until(() => events(path).some((event) => event.event === "called"));
    await send(bridge, "notifications/cancelled", undefined, { requestId: "wait" });
    expect(RpcReply.parse(await (await pending).json()).error?.message).toContain("cancelled");
    await until(() => events(path).some((event) => event.event === "cancelled"));
    const closingCall = send(bridge, "tools/call", "close", { name: "wait" }).catch(() => undefined);
    await until(() => events(path).filter((event) => event.event === "called").length === 2);
    await bridge.close();
    await closingCall;
    await bridge.close();
    await waitForProcessStopped(events(path)[0]!.pid);
  } finally {
    await bridge.close();
  }
});

test("local MCP isolates endpoint tokens, request ids and processes", async () => {
  const directory = temporary("canopy-local-mcp-isolation-");
  const paths = [join(directory, "first.jsonl"), join(directory, "second.jsonl")];
  const calls: string[] = [];

  const bridge = createLocalAutomationMcp({
    servers: [descriptor("first", paths[0]!), descriptor("second", paths[1]!)],
    env: {},
    authorize: async (name) => {
      calls.push(name);
    },
  });

  try {
    expect((await fetch(bridge.servers[1]!.url, { method: "POST", headers: bridge.servers[0]!.headers })).status).toBe(
      401,
    );
    const first = send(bridge, "tools/call", 5, { name: "wait" }, 0);
    const second = send(bridge, "tools/call", 5, { name: "wait" }, 1);
    await until(() => paths.every((path) => events(path).some((event) => event.event === "called")));
    await send(bridge, "notifications/cancelled", undefined, { requestId: 5 }, 0);
    await first;
    expect(events(paths[1]!).some((event) => event.event === "cancelled")).toBe(false);
    expect(events(paths[0]!)[0]!.pid).not.toBe(events(paths[1]!)[0]!.pid);
    await send(bridge, "notifications/cancelled", undefined, { requestId: 5 }, 1);
    await second;
    expect(calls.sort()).toEqual(["first", "second"]);
  } finally {
    await bridge.close();
  }
});

test("local MCP bounds bodies, child output and pending requests", async () => {
  const path = join(temporary("canopy-local-mcp-limits-"), "events.jsonl");
  let authorized = 0;

  const bridge = createLocalAutomationMcp({
    servers: [descriptor("limits", path)],
    env: {},
    authorize: async (_name, toolName) => {
      if (toolName === "blocked") {
        authorized++;
        await new Promise<void>(() => {});
      }
    },
  });

  try {
    const endpoint = bridge.servers[0]!;

    const tooLarge = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: " ".repeat(MAX_BYTES + 1),
    });

    expect(tooLarge.status).toBe(413);
    expect(events(path)).toEqual([]);

    const waiting = Array.from({ length: MAX_PENDING }, (_item, index) =>
      send(bridge, "tools/call", index, { name: "blocked" }),
    );

    await until(() => authorized === MAX_PENDING);
    expect(RpcReply.parse(await (await send(bridge, "ping", "overflow")).json()).error?.message).toContain("Too many");
    expect(RpcReply.parse(await (await send(bridge, "ping", 0)).json()).error?.message).toContain("Duplicate");

    for (let index = 0; index < MAX_PENDING; index++)
      await send(bridge, "notifications/cancelled", undefined, { requestId: index });
    await Promise.all(waiting);
    const oversized = RpcReply.parse(await (await send(bridge, "tools/call", "large", { name: "oversized" })).json());
    expect(oversized.error?.code).toBe(-32603);
  } finally {
    await bridge.close();
  }
});

test("local MCP close waits for a child that ignores stdin closure and termination", async () => {
  const path = join(temporary("canopy-local-mcp-stubborn-"), "events.jsonl");

  const bridge = createLocalAutomationMcp({
    servers: [descriptor("stubborn", path)],
    env: { CANOPY_MCP_STUBBORN: "1" },
    authorize: async () => {},
  });

  try {
    expect((await send(bridge, "initialize")).status).toBe(200);
    const pid = events(path)[0]!.pid;
    await bridge.close();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await bridge.close();
  }
}, 10_000);

test("local MCP closes during initialization and reports failed executables without exposing their paths", async () => {
  const path = join(temporary("canopy-local-mcp-startup-"), "events.jsonl");

  const bridge = createLocalAutomationMcp({
    servers: [descriptor("startup", path)],
    env: { CANOPY_MCP_NO_INITIALIZE: "1" },
    authorize: async () => {},
  });

  try {
    const pending = send(bridge, "initialize").catch(() => undefined);
    await until(() => events(path).some((event) => event.event === "started"));
    await bridge.close();
    await pending;
    await waitForProcessStopped(events(path)[0]!.pid);
  } finally {
    await bridge.close();
  }

  const missing = createLocalAutomationMcp({
    servers: [{ name: "missing", command: join(path, "missing-executable"), args: [] }],
    env: {},
    authorize: async () => {},
  });

  try {
    const result = RpcReply.parse(await (await send(missing, "initialize")).json());
    expect(result.error).toEqual({ code: -32603, message: "Local automation failed" });
  } finally {
    await missing.close();
  }
});

test("local MCP HTTP disconnection cancels pending authorization without starting a child", async () => {
  const path = join(temporary("canopy-local-mcp-disconnect-"), "events.jsonl");
  let authorizationSignal: AbortSignal | undefined;

  const bridge = createLocalAutomationMcp({
    servers: [descriptor("disconnect", path)],
    env: {},
    authorize: async (_name, _tool, _args, signal) => {
      authorizationSignal = signal;
      await new Promise<void>(() => {});
    },
  });

  const controller = new AbortController();

  try {
    const endpoint = bridge.servers[0]!;

    const request = fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } }),
      signal: controller.signal,
    }).catch(() => undefined);

    await until(() => authorizationSignal !== undefined);
    controller.abort();
    await request;
    await until(() => authorizationSignal?.aborted === true);
    expect(events(path)).toEqual([]);
  } finally {
    await bridge.close();
  }
});

test("local MCP body reader cancels stalled streams on its deadline and bounds bodies without content-length", async () => {
  let cancelled = false;
  const deadline = requestDeadline([], 20);

  try {
    const stalled = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    });

    await expect(readRequest(stalled, deadline.signal)).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);

    const oversized = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    });

    await expect(readRequest(oversized, new AbortController().signal)).rejects.toThrow("Request too large");
  } finally {
    deadline.dispose();
  }
});

test("local MCP forwards only approved session overrides and isolates them from worker and sibling environments", async () => {
  const directory = temporary("canopy-local-mcp-session-env-");
  const previousSession = process.env["AGENT_DEVICE_SESSION"];
  const previousBrowserSession = process.env["AGENT_BROWSER_SESSION"];
  process.env["AGENT_DEVICE_SESSION"] = "ambient-session";
  process.env["AGENT_BROWSER_SESSION"] = "ambient-browser-session";

  const descriptorEnvironment = {
    AGENT_DEVICE_SESSION: "thread-device-session",
    CANOPY_MCP_PARENT_ONLY: "descriptor-variable-must-not-pass",
    ANTHROPIC_API_KEY: "fixture-must-not-pass",
  };

  const bridge = createLocalAutomationMcp({
    servers: [
      { ...descriptor("agent_device", join(directory, "device.jsonl")), env: descriptorEnvironment },
      {
        ...descriptor("agent_browser", join(directory, "browser.jsonl")),
        env: { AGENT_BROWSER_SESSION: "thread-browser-session" },
      },
      descriptor("agent_desktop", join(directory, "desktop.jsonl")),
    ],
    env: { AGENT_DEVICE_SESSION: "base-session-collision", AGENT_BROWSER_SESSION: "base-browser-collision" },
    authorize: async () => {},
  });

  try {
    for (let index = 0; index < bridge.servers.length; index++) {
      const result = RpcReply.parse(await (await send(bridge, "tools/call", 1, { name: "echo" }, index)).json());

      const echo = z
        .object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) })
        .parse(result.result);

      const environment = z
        .object({
          deviceSession: z.string(),
          browserSession: z.string(),
          providerKeyPresent: z.boolean(),
          parentOnly: z.string(),
        })
        .parse(JSON.parse(echo.content[0]!.text));

      expect(environment).toEqual({
        deviceSession: index === 0 ? "thread-device-session" : "",
        browserSession: index === 1 ? "thread-browser-session" : "",
        providerKeyPresent: false,
        parentOnly: "",
      });
    }
  } finally {
    await bridge.close();

    if (previousSession === undefined) delete process.env["AGENT_DEVICE_SESSION"];
    else process.env["AGENT_DEVICE_SESSION"] = previousSession;

    if (previousBrowserSession === undefined) delete process.env["AGENT_BROWSER_SESSION"];
    else process.env["AGENT_BROWSER_SESSION"] = previousBrowserSession;
  }
});
