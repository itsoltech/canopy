import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentTool } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { z } from "zod";
import { createLocalAutomationMcp } from "../agent-tools-mcp/index.ts";
import { managedDeviceMcp } from "./device-mcp.ts";
import { DevicePool, type Device } from "./device-pool.ts";

const temporary = tempDirs();
const sessions: [string, string] = ["device-thread-first", "device-thread-second"];
const TextResult = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });

const Reply = z.object({
  result: z.json().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const Forwarded = z.object({ arguments: z.record(z.string(), z.json()) });
const Event = z.object({ event: z.string() });
const Catalog = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional() })) });

const android: Device = {
  id: "emulator-5554",
  name: "Canopy Android",
  platform: "android",
  kind: "emulator",
  booted: true,
};

const ios: Device = {
  id: "simulator-udid",
  name: "Canopy iOS",
  platform: "ios",
  kind: "simulator",
  booted: true,
};

function fixture(initial: Device[]) {
  const dataDir = temporary("canopy-device-managed-");
  const devices = initial.map((device) => ({ ...device }));
  const booted: string[] = [];
  const stopped: string[] = [];
  const closed: string[] = [];
  const observe = { scan: () => {} };
  const paths = sessions.map((session) => join(dataDir, `${session}.jsonl`));

  const pool = new DevicePool({
    dataDir,
    backend: {
      async devices() {
        observe.scan();

        return devices.map((device) => ({ ...device }));
      },
      async boot(device) {
        booted.push(device.id);
        const actual = devices.find((candidate) => candidate.id === device.id);

        if (!actual) throw new Error("Unknown fake device");
        actual.booted = true;

        return { ...actual };
      },
      async shutdown(device) {
        stopped.push(device.id);
        const actual = devices.find((candidate) => candidate.id === device.id);

        if (actual) actual.booted = false;
      },
      async closeSession(session) {
        closed.push(session);
      },
    },
  });

  const bridge = createLocalAutomationMcp({
    servers: sessions.map((session, index) => ({
      name: `device_${index}`,
      command: process.execPath,
      args: [join(import.meta.dir, "../agent-tools-mcp/fixtures/server.ts"), paths[index]!],
      scope: { tool: AgentTool.DEVICE, session },
      managed: managedDeviceMcp(pool, session, () => pool.release(session)),
    })),
    env: { CANOPY_MCP_DEVICE_POLICY: "1" },
    authorize: async () => {},
  });

  let requestId = 0;

  async function rpc(index: number, method: string, params = {}) {
    // SAFETY: tests use indices 0 and 1 for the two fixture descriptors.
    const endpoint = bridge.servers[index]!;

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });

    return Reply.parse(await response.json());
  }

  function calls(index: number) {
    // SAFETY: tests use indices 0 and 1 for the two fixture event files.
    const path = paths[index]!;

    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => Event.parse(JSON.parse(line)))
          .filter((event) => event.event === "called").length
      : 0;
  }

  return {
    pool,
    booted,
    stopped,
    closed,
    observe,
    rpc,
    calls,
    call: (index: number, name: string, args = {}) => rpc(index, "tools/call", { name, arguments: args }),
    async close() {
      await bridge.close();
      await pool.close();
    },
  };
}

function argumentsOf(reply: z.infer<typeof Reply>) {
  expect(reply.error).toBeUndefined();
  const result = TextResult.parse(reply.result);

  // SAFETY: the existing MCP fixture returns one JSON text block for device tools.
  return Forwarded.parse(JSON.parse(result.content[0]!.text)).arguments;
}

test("managed device MCP reserves target calls and pins Android serials and Apple UDIDs to each thread", async () => {
  const f = fixture([android, ios]);

  try {
    const catalog = Catalog.parse((await f.rpc(0, "tools/list")).result);
    expect(catalog.tools.map((tool) => tool.name)).toContain("acquire_device");
    expect(catalog.tools.map((tool) => tool.name)).toContain("release_device");
    expect(catalog.tools.map((tool) => tool.name)).not.toContain("replay");
    expect(catalog.tools.map((tool) => tool.name)).not.toContain("test");
    expect(catalog.tools.find((tool) => tool.name === "batch")?.description).not.toContain(
      "Use replay for each script",
    );
    expect(argumentsOf(await f.call(0, "devices"))).toEqual({ session: sessions[0] });
    expect(f.pool.current(sessions[0])).toBeUndefined();

    for (const name of ["apps", "open", "snapshot", "screenshot", "close", "session"]) {
      expect(argumentsOf(await f.call(0, name))).toEqual({
        session: sessions[0],
        platform: "android",
        serial: android.id,
      });
      expect(f.pool.current(sessions[0])?.id).toBe(android.id);
    }

    expect((await f.call(1, "acquire_device", { platform: "apple" })).error).toBeUndefined();
    expect(argumentsOf(await f.call(1, "snapshot", { platform: "apple", udid: ios.id }))).toEqual({
      session: sessions[1],
      platform: "ios",
      udid: ios.id,
    });
    expect(f.pool.current(sessions[1])?.id).toBe(ios.id);
    const before = f.calls(0);
    expect((await f.call(0, "snapshot", { serial: ios.id })).error).toBeDefined();
    expect((await f.call(0, "snapshot", { platform: "ios" })).error).toBeDefined();
    expect(f.calls(0)).toBe(before);
    expect(f.booted).toEqual([]);
  } finally {
    await f.close();
  }
});

test("managed device batches pin every step and reject target changes and embedded lifecycle commands", async () => {
  const f = fixture([android, ios]);

  try {
    expect((await f.call(0, "acquire_device", { serial: android.id })).error).toBeUndefined();

    const args = argumentsOf(
      await f.call(0, "batch", {
        steps: [
          { command: "open", input: { app: "tech.itsol.canopy_remote" }, runtime: { timeoutMs: 1000 } },
          { command: "snapshot", input: { serial: android.id } },
        ],
        onError: "stop",
      }),
    );

    expect(args).toEqual({
      session: sessions[0],
      platform: "android",
      serial: android.id,
      onError: "stop",
      steps: [
        {
          command: "open",
          input: {
            app: "tech.itsol.canopy_remote",
            session: sessions[0],
            platform: "android",
            serial: android.id,
          },
          runtime: { timeoutMs: 1000 },
        },
        { command: "snapshot", input: { session: sessions[0], platform: "android", serial: android.id } },
      ],
    });
    const before = f.calls(0);

    for (const input of [{ serial: ios.id }, { platform: "ios" }, { session: sessions[1] }]) {
      expect((await f.call(0, "batch", { steps: [{ command: "snapshot", input }] })).error).toBeDefined();
    }

    for (const command of [
      "boot",
      "shutdown",
      "acquire_device",
      "release_device",
      "replay",
      "test",
      "batch",
      "close",
    ]) {
      expect((await f.call(0, "batch", { steps: [{ command, input: {} }] })).error).toBeDefined();
    }

    expect((await f.call(0, "replay", { path: "script.ad" })).error).toBeDefined();
    expect((await f.call(0, "close", { shutdown: true })).error).toBeDefined();
    expect(f.calls(0)).toBe(before);
    expect(f.pool.current(sessions[0])?.id).toBe(android.id);
    expect(f.stopped).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a managed MCP acquisition waits until another thread releases the same device", async () => {
  const f = fixture([android]);
  const scanned = Promise.withResolvers<void>();
  let acquired = false;

  try {
    expect((await f.call(0, "acquire_device", { serial: android.id })).error).toBeUndefined();
    expect((await f.call(1, "snapshot", { serial: android.id })).error).toBeDefined();
    expect(f.calls(1)).toBe(0);
    f.observe.scan = () => scanned.resolve();

    const waiting = f.call(1, "acquire_device", { serial: android.id, boot: false, timeoutMs: 2000 }).then((reply) => {
      acquired = true;

      return reply;
    });

    await scanned.promise;
    expect(acquired).toBe(false);
    expect(f.pool.current(sessions[1])).toBeUndefined();
    expect(f.calls(1)).toBe(0);
    expect((await f.call(0, "release_device")).error).toBeUndefined();
    expect((await waiting).error).toBeUndefined();
    expect(f.pool.current(sessions[0])).toBeUndefined();
    expect(f.pool.current(sessions[1])?.id).toBe(android.id);
    expect(argumentsOf(await f.call(1, "snapshot"))).toEqual({
      session: sessions[1],
      platform: "android",
      serial: android.id,
    });
    expect(f.stopped).toEqual([]);
  } finally {
    await f.close();
  }
});

test("managed release shuts down only virtual devices booted by Canopy and preserves other reservations", async () => {
  const phone: Device = { id: "physical-phone", name: "Phone", platform: "android", kind: "device", booted: true };
  const f = fixture([{ ...android, booted: false }, ios, phone]);

  try {
    expect((await f.call(0, "boot", { serial: android.id })).error).toBeUndefined();
    expect((await f.call(1, "acquire_device", { udid: ios.id })).error).toBeUndefined();
    expect(f.booted).toEqual([android.id]);
    expect((await f.call(0, "release_device", { serial: ios.id })).error).toBeDefined();
    expect(f.stopped).toEqual([]);
    expect((await f.call(0, "release_device")).error).toBeUndefined();
    expect(f.stopped).toEqual([android.id]);
    expect(f.closed).toContain(sessions[0]);
    expect(f.closed).not.toContain(sessions[1]);
    expect(f.pool.current(sessions[1])?.id).toBe(ios.id);
    expect(argumentsOf(await f.call(1, "snapshot"))["udid"]).toBe(ios.id);
    expect((await f.call(1, "shutdown")).error).toBeUndefined();
    expect(f.pool.current(sessions[1])).toBeUndefined();
    expect((await f.call(0, "acquire_device", { serial: phone.id })).error).toBeUndefined();
    expect((await f.call(0, "release_device")).error).toBeUndefined();
    expect(f.stopped).toEqual([android.id]);
  } finally {
    await f.close();
  }
});

test("busy targets reject all target tool calls before upstream MCP receives them", async () => {
  const f = fixture([{ ...android, busy: true }]);

  try {
    for (const name of ["apps", "open", "snapshot", "screenshot", "close", "session", "batch"]) {
      const args = name === "batch" ? { steps: [{ command: "snapshot", input: {} }] } : {};
      expect((await f.call(0, name, args)).error).toBeDefined();
      expect(f.pool.current(sessions[0])).toBeUndefined();
    }

    expect(f.calls(0)).toBe(0);
    expect(f.booted).toEqual([]);
    expect(f.stopped).toEqual([]);
  } finally {
    await f.close();
  }
});
