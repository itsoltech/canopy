import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentTool } from "@canopy/contracts";
import { z } from "zod";
import { createDeviceBackend } from "./device-backend.ts";
import { DeviceBootNotStartedError, type Device } from "./device-pool.ts";
import { executable, fixture } from "./fixtures.test-support.ts";

const android = { id: "Pixel_9", name: "Pixel_9", platform: "android", kind: "emulator", booted: false } as const;

const ios = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "iPhone 17",
  platform: "ios",
  kind: "simulator",
  booted: false,
} as const;

const physical = { id: "usb-phone", name: "Phone", platform: "android", kind: "device", booted: true } as const;
const running = { ...android, id: "emulator-5556", name: "Pixel 9", booted: true };
const claimed = { session: "external", workspace: "/external" };

interface BackendState {
  devices: Device[];
  sessions: { id: string; platform: string }[];
  version?: string;
  daemon?: string;
  closeCode?: string;
  bootId?: string;
  shutdownSuccess?: boolean;
  waitInventory?: string;
  waitBoot?: string;
}

function backendFixture() {
  const f = fixture();
  const statePath = join(f.dir, "device-pool-state.json");
  const logPath = join(f.dir, "device-pool-calls.jsonl");

  const state = (value: Partial<BackendState>) =>
    writeFileSync(statePath, JSON.stringify({ devices: [], sessions: [], ...value }));

  const calls = () =>
    !existsSync(logPath)
      ? []
      : z.array(z.object({ args: z.array(z.string()), secret: z.boolean() })).parse(
          readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );

  const path = executable(
    f.path(AgentTool.DEVICE),
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
let state = JSON.parse(readFileSync(statePath, "utf8"));
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args,secret:Boolean(process.env.CANOPY_WORKER_TOKEN || process.env.API_KEY)}) + "\\n");
const ok = data => console.log(JSON.stringify({success:true,data}));
const fail = code => { console.log(JSON.stringify({success:false,error:{code,message:"failure provider-private-value"}}));process.exit(1); };
if (args.includes("--version")) { console.log(state.version ?? "0.21.37"); process.exit(0); }
if (args[0] !== "--json") fail("MISSING_JSON");
const option = flag => args[args.indexOf(flag) + 1];
if (!args.includes("daemon") && option("--daemon-transport") !== "socket") fail("REMOTE_TRANSPORT");
if (args.includes("daemon") && args.includes("--daemon-transport")) fail("OFFLINE_STATUS_TRANSPORT");
const session = option("--session");
if (args.at(-1) === "devices") {
  if (state.waitInventory) while (!existsSync(state.waitInventory)) await new Promise(resolve => setTimeout(resolve,5));
  ok({devices:state.devices});
} else if (args.at(-2) === "session" && args.at(-1) === "list") ok({sessions:state.sessions});
else if (args.at(-2) === "daemon" && args.at(-1) === "status") ok({state:state.daemon ?? "running"});
else if (args.at(-1) === "close") {
  if (state.closeCode) fail(state.closeCode);
  state.sessions=[];writeFileSync(statePath,JSON.stringify(state));ok({closed:"session",session});
} else if (args.includes("boot") || args.includes("shutdown")) {
  if (session !== "canopy-device-pool") fail("WRONG_SESSION");
  const flag = args.includes("--udid") ? "--udid" : args.includes("--serial") ? "--serial" : "--device";
  const device = state.devices.find(d => d.id === option(flag));
  if (!device) fail("WRONG_DEVICE");
  if (args.includes("boot")) {
    if (state.waitBoot) while (!existsSync(state.waitBoot)) await new Promise(resolve => setTimeout(resolve,5));
    if (!args.includes("--timeout")) fail("NO_TIMEOUT");
    if (device.platform === "android" && !args.includes("--headless")) fail("NOT_HEADLESS");
    device.id = state.bootId ?? (device.platform === "android" ? "emulator-5556" : device.id);
    device.booted=true;writeFileSync(statePath,JSON.stringify(state));
    ok({platform:device.platform,id:device.id,device:device.name,kind:device.kind,booted:true});
  } else { device.booted=false;
    if (device.platform === "android") state.devices = state.devices.filter(candidate => candidate.id !== device.id);
    writeFileSync(statePath,JSON.stringify(state));
    ok({platform:device.platform,id:device.id,device:device.name,kind:device.kind,shutdown:{success:state.shutdownSuccess!==false}}); }
} else fail("UNEXPECTED_COMMAND");
`,
  );

  state({});
  const backend = createDeviceBackend(() => ({ env: f.env, which: (name) => (name === "agent-device" ? path : null) }));

  return { ...f, state, calls, backend };
}

const signal = () => AbortSignal.timeout(10_000);

test("inventory works with every virtual stopped and marks claim/session ownership busy", async () => {
  const f = backendFixture();

  const state = {
    devices: [{ ...android, claimedBy: claimed }, ios, physical],
    sessions: [{ id: ios.id, platform: ios.platform }],
  };

  writeFileSync(join(f.dir, "device-pool-state.json"), JSON.stringify(state));
  expect(await f.backend.devices(signal())).toEqual([
    { ...android, busy: true },
    { ...ios, busy: true },
    { ...physical, busy: false },
  ]);
  expect(f.calls().some((call) => call.secret || call.args.includes("doctor"))).toBe(false);
  expect(
    f
      .calls()
      .filter((call) => !call.args.includes("--version"))
      .map((call) => call.args),
  ).toEqual([
    ["--json", "--daemon-transport", "socket", "--session", "canopy-device-pool", "devices"],
    ["--json", "--daemon-transport", "socket", "--session", "canopy-device-pool", "session", "list"],
  ]);
});

test("boot returns Android serial and shutdown targets that exact serial after session close", async () => {
  const f = backendFixture();
  f.state({ devices: [android] });
  const booted = await f.backend.boot(android, signal());
  expect(booted).toMatchObject({ id: "emulator-5556", booted: true });
  f.state({ devices: [running], sessions: [{ id: running.id, platform: "android" }] });
  await expect(f.backend.shutdown(booted, signal())).rejects.toThrow("held by another session");
  await f.backend.closeSession("thread-one");
  await f.backend.shutdown(booted, signal());
  expect(f.calls().find((call) => call.args.includes("shutdown"))?.args).toEqual([
    "--json",
    "--daemon-transport",
    "socket",
    "--session",
    "canopy-device-pool",
    "--platform",
    "android",
    "--serial",
    "emulator-5556",
    "shutdown",
  ]);
  expect(f.calls().find((call) => call.args.includes("close"))?.args).toEqual([
    "--json",
    "--daemon-transport",
    "socket",
    "--session",
    "thread-one",
    "close",
  ]);
});

test("Apple boot uses UDID and never passes unsupported headless", async () => {
  const f = backendFixture();
  f.state({ devices: [ios] });
  const booted = await f.backend.boot(ios, signal());
  await f.backend.shutdown(booted, signal());
  expect(f.calls().find((call) => call.args.includes("boot"))?.args).toEqual([
    "--json",
    "--daemon-transport",
    "socket",
    "--session",
    "canopy-device-pool",
    "--platform",
    "ios",
    "--udid",
    ios.id,
    "boot",
    "--timeout",
    "120000",
  ]);
});

test("physical targets and busy or externally started virtuals never receive lifecycle commands", async () => {
  const f = backendFixture();
  await expect(f.backend.boot(physical, signal())).rejects.toThrow("only starts and stops");
  await expect(f.backend.shutdown(physical, signal())).rejects.toThrow("only starts and stops");
  f.state({ devices: [ios], sessions: [{ id: ios.id, platform: ios.platform }] });
  await expect(f.backend.boot(ios, signal())).rejects.toThrow("unavailable or in use");
  f.state({ devices: [{ ...ios, booted: true }] });
  await expect(f.backend.boot(ios, signal())).rejects.toThrow("outside this reservation");
  await expect(f.backend.boot(ios, signal())).rejects.toBeInstanceOf(DeviceBootNotStartedError);
  f.state({ devices: [running] });
  await expect(f.backend.boot(android, signal())).rejects.toThrow("unavailable or in use");
  await expect(f.backend.shutdown(android, signal())).rejects.toThrow("Cannot prove ownership");
  expect(f.calls().some((call) => call.args.includes("boot") || call.args.includes("shutdown"))).toBe(false);
});

test("cleanup safely retries an already stopped Android serial without guessing another AVD", async () => {
  const f = backendFixture();
  f.state({ devices: [android] });
  await f.backend.shutdown(running, signal());
  expect(f.calls().some((call) => call.args.includes("shutdown"))).toBe(false);
});

test("an ambiguous pre-runtime Android startup retains ownership even while inventory is stopped or absent", async () => {
  const f = backendFixture();
  f.state({ devices: [android] });
  await expect(f.backend.shutdown(android, signal())).rejects.toThrow("Cannot prove ownership");
  f.state({ devices: [] });
  await expect(f.backend.shutdown(android, signal())).rejects.toThrow("Cannot prove ownership");
  expect(f.calls()).toEqual([]);
});

test("cleanup retains a booting Android serial and shuts down Apple even before Booted", async () => {
  const f = backendFixture();
  f.state({ devices: [{ ...running, booted: false }] });
  await expect(f.backend.shutdown(running, signal())).rejects.toThrow("still booting");
  expect(f.calls().some((call) => call.args.includes("shutdown"))).toBe(false);
  f.state({ devices: [ios] });
  await f.backend.shutdown(ios, signal());
  expect(f.calls().some((call) => call.args.includes("shutdown"))).toBe(true);
});

test("boot validates returned virtual identity before the pool can persist it", async () => {
  const f = backendFixture();
  f.state({ devices: [android], bootId: "usb-phone" });
  await expect(f.backend.boot(android, signal())).rejects.toThrow("different Android AVD");
  f.state({ devices: [ios], bootId: "other-simulator" });
  await expect(f.backend.boot(ios, signal())).rejects.toThrow("different device");
});

test("unsupported versions cannot run inventory and successful envelopes need successful shutdown", async () => {
  const f = backendFixture();
  f.state({ version: "0.21.36" });
  await expect(f.backend.devices(signal())).rejects.toThrow("0.21.37");
  expect(f.calls().map((call) => call.args)).toEqual([["--version"]]);
  f.state({ devices: [running], shutdownSuccess: false });
  await expect(f.backend.shutdown(running, signal())).rejects.toThrow();
});

test("provider identities and non-native simulator IDs cannot enter the local pool", async () => {
  const f = backendFixture();
  f.state({ devices: [{ ...ios, id: "hosted:ios:lease-one" }] });
  await expect(f.backend.devices(signal())).rejects.toThrow("provider inventory is unsupported");
  f.state({ devices: [{ ...ios, id: "custom-simulator" }] });
  await expect(f.backend.devices(signal())).rejects.toThrow("native simulator UDID");
  await expect(f.backend.boot({ ...ios, id: "hosted:ios:lease-one" }, signal())).rejects.toBeInstanceOf(
    DeviceBootNotStartedError,
  );
  expect(f.calls().some((call) => call.args.includes("boot") || call.args.includes("shutdown"))).toBe(false);
});

test("session cleanup avoids daemon startup, accepts missing sessions, redacts failures", async () => {
  const f = backendFixture();
  f.state({ daemon: "stopped" });
  await f.backend.closeSession("thread-one");
  expect(f.calls().some((call) => call.args.includes("close"))).toBe(false);
  f.state({ closeCode: "SESSION_NOT_FOUND" });
  await f.backend.closeSession("thread-one");
  f.state({ closeCode: "COMMAND_FAILED" });
  await expect(f.backend.closeSession("thread-one")).rejects.toThrow("failure ***");
  f.state({ daemon: "unreadable" });
  await expect(f.backend.closeSession("thread-one")).rejects.toThrow("registration cannot be read");
});

test("aborting inventory cancels the owned CLI before any boot", async () => {
  const f = backendFixture();
  f.state({ waitInventory: join(f.dir, "never-released") });
  const controller = new AbortController();
  const pending = f.backend.devices(controller.signal);
  const deadline = Date.now() + 3000;

  while (!f.calls().some((call) => call.args.includes("devices"))) {
    if (Date.now() > deadline) throw new Error("Inventory fixture did not start");
    await Bun.sleep(5);
  }

  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(f.calls().some((call) => call.args.includes("boot"))).toBe(false);
});

test("cancellation after dispatch drains startup and preserves its runtime serial for cleanup", async () => {
  const f = backendFixture();
  const gate = join(f.dir, "release-boot");
  f.state({ devices: [android], waitBoot: gate });
  const controller = new AbortController();
  const pending = f.backend.boot(android, controller.signal);
  const deadline = Date.now() + 3000;
  let settled = false;
  void pending
    .finally(() => {
      settled = true;
    })
    .catch(() => {});

  try {
    while (!f.calls().some((call) => call.args.includes("boot"))) {
      if (Date.now() > deadline) throw new Error("Boot fixture did not start");
      await Bun.sleep(5);
    }

    controller.abort();
    await Bun.sleep(25);
    expect(settled).toBe(false);
    writeFileSync(gate, "");
    const device = await pending;
    expect(device.id).toBe("emulator-5556");
    await f.backend.shutdown(device, signal());
  } finally {
    writeFileSync(gate, "");
    await pending;
  }
});
