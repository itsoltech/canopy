import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, AgentTool, RunAgentToolSchema } from "@canopy/contracts";
import { processGovernor } from "@canopy/process-governor";
import { tempDirs } from "@canopy/testing";
import { executable } from "../agent-tools/fixtures.test-support.ts";
import { serializeAgentTool } from "../agent-tools/queue.ts";
import { deviceKey, type DeviceKeyRuntime } from "./device-keys.ts";

const temp = tempDirs();
const input = (key: string, modifiers = 0) => create(AgentPreviewInputSchema, { kind: "key-down", key, modifiers });

interface NativeCall {
  args: string[];
  source: string;
  pid: number;
  privateEnv: boolean;
  setting: string;
  androidSerial: string;
}

interface NativeState {
  inventory?: string;
  inventoryExit?: number;
  keyExit?: number;
  block?: "inventory" | "key";
  outputBytes?: number;
}

function fixture() {
  const root = temp("canopy-device-keys-");
  const sdk = join(root, "configured sdk");
  const sdkHome = join(root, "other sdk");
  const bin = join(root, "path bin");
  const log = join(root, "calls.jsonl");
  const state = join(root, "state.json");
  const controller = new AbortController();
  writeFileSync(state, "{}");

  const script = (source: string) => `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const inventory = args.length === 2 && args[0] === "devices" && args[1] === "-l";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args, source: ${JSON.stringify(source)}, pid: process.pid,
  privateEnv: Boolean(process.env.CANOPY_DEVICE_KEY_TEST || process.env.API_KEY),
  setting: process.env.AGENT_TEST_SETTING ?? "",
  androidSerial: process.env.ANDROID_SERIAL ?? "",
}) + "\\n");
if ((inventory && state.block === "inventory") || (!inventory && state.block === "key"))
  await new Promise(() => setInterval(() => {}, 1000));
if (state.outputBytes) { console.log("x".repeat(state.outputBytes)); process.exit(0); }
if (inventory) {
  console.log(state.inventory ?? "List of devices attached\\nemulator-5554 device product:test\\nemulator-5556 device product:other\\n");
  process.exit(state.inventoryExit ?? 0);
}
if (args.length !== 6 || args[0] !== "-s" || args[2] !== "shell" || args[3] !== "input" || args[4] !== "keyevent")
  process.exit(19);
if (state.keyExit) console.error("private-native-error-do-not-forward");
process.exit(state.keyExit ?? 0);
`;

  const name = process.platform === "win32" ? "adb.exe" : "adb";
  executable(join(sdk, "platform-tools", name), script("sdk"));
  executable(join(sdkHome, "platform-tools", name), script("sdk-home"));
  executable(join(bin, name), script("path"));

  const runtime: DeviceKeyRuntime = {
    scope: create(RunAgentToolSchema, { tool: AgentTool.DEVICE, platform: "android", deviceId: "emulator-5554" }),
    env: {
      HOME: root,
      ANDROID_SDK_ROOT: sdk,
      ANDROID_HOME: sdkHome,
      PATH: bin,
      ANDROID_SERIAL: "unrelated-ambient-device",
      AGENT_TEST_SETTING: "kept",
      CANOPY_DEVICE_KEY_TEST: "worker-private-sentinel",
      API_KEY: "provider-private-sentinel",
    },
    signal: controller.signal,
  };

  return {
    root,
    sdkHome,
    bin,
    runtime,
    controller,
    state: (value: NativeState) => writeFileSync(state, JSON.stringify(value)),
    calls: (): NativeCall[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Device key test timed out");
    await Bun.sleep(5);
  }
}

test("Android editing targets the exact selected serial using SDK adb, fixed native keys and a private environment", async () => {
  const f = fixture();
  const previous = process.env["CANOPY_DEVICE_KEY_TEST"];
  process.env["CANOPY_DEVICE_KEY_TEST"] = "ambient-private-sentinel";

  try {
    for (const key of [
      "Backspace",
      "Delete",
      "Tab",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "End",
      "PageUp",
      "PageDown",
    ])
      expect(await deviceKey(f.runtime, input(key))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env["CANOPY_DEVICE_KEY_TEST"];
    else process.env["CANOPY_DEVICE_KEY_TEST"] = previous;
  }

  const calls = f.calls();
  expect(calls).toHaveLength(20);
  expect(calls.every((call) => call.source === "sdk" && !call.privateEnv && call.setting === "kept")).toBe(true);
  expect(calls.filter((call) => call.args[0] === "devices").every((call) => call.args.join(" ") === "devices -l")).toBe(
    true,
  );
  expect(calls.filter((call) => call.args[0] === "-s").map((call) => call.args)).toEqual([
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_DEL"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_FORWARD_DEL"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_TAB"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_DPAD_LEFT"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_DPAD_RIGHT"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_DPAD_UP"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_DPAD_DOWN"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_MOVE_END"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_PAGE_UP"],
    ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_PAGE_DOWN"],
  ]);
  expect(calls.every((call) => call.androidSerial === "unrelated-ambient-device")).toBe(true);
});

test("adb resolution uses the existing SDK home and then PATH without changing the selection", async () => {
  const f = fixture();
  const env = { ...f.runtime.env, ANDROID_SDK_ROOT: join(f.root, "missing") };
  expect(await deviceKey({ ...f.runtime, env }, input("Backspace"))).toBe(true);
  expect(f.calls().every((call) => call.source === "sdk-home")).toBe(true);

  const pathEnv = { ...env, ANDROID_HOME: join(f.root, "also-missing") };
  f.runtime.scope.deviceId = "emulator-5556";
  expect(await deviceKey({ ...f.runtime, env: pathEnv }, input("Backspace"))).toBe(true);
  expect(f.calls().at(-1)?.source).toBe("path");
  expect(f.calls().at(-1)?.args).toEqual(["-s", "emulator-5556", "shell", "input", "keyevent", "KEYCODE_DEL"]);

  await expect(deviceKey({ ...f.runtime, env: { ...pathEnv, PATH: "" } }, input("Backspace"))).rejects.toThrow(
    "existing Android SDK",
  );
  expect(f.calls()).toHaveLength(4);
});

test("unsupported inputs and unsafe selectors cannot become arbitrary native commands", async () => {
  const f = fixture();

  for (const key of ["Enter", "Escape", "Home", "Control", "Shift", "a", "KEYCODE_POWER", "Backspace;reboot"])
    expect(await deviceKey(f.runtime, input(key))).toBe(false);
  expect(
    await deviceKey(f.runtime, create(AgentPreviewInputSchema, { kind: "text", key: "Backspace", text: "ignored" })),
  ).toBe(false);
  expect(await deviceKey(f.runtime, create(AgentPreviewInputSchema, { kind: "key-up", key: "Backspace" }))).toBe(false);

  for (const modifiers of [1, 2, 4, 8])
    await expect(deviceKey(f.runtime, input("Backspace", modifiers))).rejects.toThrow("modified keyboard shortcuts");

  for (const serial of ["", "-d", "emulator-5554\n", "emulator-5554;reboot", "emulator-5554\0"]) {
    f.runtime.scope.deviceId = serial;
    await expect(deviceKey(f.runtime, input("Backspace"))).rejects.toThrow("Select a valid Android device");
  }

  for (const platform of ["ios", "apple", "macos", "harmonyos", "vega", "web", ""]) {
    f.runtime.scope.platform = platform;
    await expect(deviceKey(f.runtime, input("Backspace"))).rejects.toThrow("available only for Android");
  }

  f.runtime.scope.tool = AgentTool.DESKTOP;
  await expect(deviceKey(f.runtime, input("Backspace"))).rejects.toThrow("requires a device preview");
  expect(f.calls()).toEqual([]);
});

test("absent, offline, ambiguous and unverified Android targets never receive a key", async () => {
  const f = fixture();

  for (const inventory of [
    "List of devices attached\nemulator-5556 device\n",
    "List of devices attached\nemulator-5554 offline\n",
    "List of devices attached\nemulator-5554 unauthorized\n",
    "List of devices attached\nemulator-5554 device\nemulator-5554 offline\n",
    "List of devices attached\nemulator-55540 device\n",
  ]) {
    f.state({ inventory });
    await expect(deviceKey(f.runtime, input("Backspace"))).rejects.toThrow("unavailable or unauthorized");
  }

  f.state({ inventoryExit: 1 });
  await expect(deviceKey(f.runtime, input("Backspace"))).rejects.toThrow("Could not verify");
  expect(f.calls()).toHaveLength(6);
  expect(f.calls().every((call) => call.args[0] === "devices")).toBe(true);

  f.state({ keyExit: 1 });
  await expect(deviceKey(f.runtime, input("Backspace"))).rejects.toThrow("rejected the editing key");
  expect(f.calls()).toHaveLength(8);
});

test("closing a preview prevents queued device keys and kills only its active native process", async () => {
  const queued = fixture();
  let release: () => void = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const busy = serializeAgentTool("operations", () => gate);
  const waiting = deviceKey(queued.runtime, input("Backspace"));
  queued.controller.abort();
  release();
  await busy;
  await expect(waiting).rejects.toThrow();
  expect(queued.calls()).toEqual([]);

  const active = fixture();
  active.state({ block: "key" });
  const running = deviceKey(active.runtime, input("Backspace"));
  await until(() => active.calls().length === 2);
  const pid = active.calls().at(-1)!.pid;
  active.controller.abort();
  await expect(running).rejects.toThrow();
  await until(() => processGovernor.snapshot().byKind["utility"] === 0);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(active.calls()).toHaveLength(2);
});

test("a stalled or oversized inventory is bounded and cannot dispatch a later key", async () => {
  const stalled = fixture();
  stalled.state({ block: "inventory" });
  await expect(deviceKey(stalled.runtime, input("Backspace"))).rejects.toThrow("time or output limit");
  expect(stalled.calls()).toHaveLength(1);

  const oversized = fixture();
  oversized.state({ outputBytes: 128 * 1024 });
  await expect(deviceKey(oversized.runtime, input("Backspace"))).rejects.toThrow("time or output limit");
  expect(oversized.calls()).toHaveLength(1);
}, 10_000);
