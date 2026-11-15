import { statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { AgentTool, type AgentPreviewInput, type RunAgentTool } from "@canopy/contracts";
import { runProcess } from "@canopy/process-governor";
import { z } from "zod";
import { installEnv } from "../cli-tools/installer.ts";
import type { ToolEnv } from "../agent-tools/paths.ts";
import { serializeAgentTool } from "../agent-tools/queue.ts";

export interface DeviceKeyRuntime {
  readonly scope: RunAgentTool;
  readonly env: ToolEnv;
  readonly signal: AbortSignal;
}

const KEYS = new Map(
  Object.entries({
    Backspace: "KEYCODE_DEL",
    Delete: "KEYCODE_FORWARD_DEL",
    Tab: "KEYCODE_TAB",
    ArrowLeft: "KEYCODE_DPAD_LEFT",
    ArrowRight: "KEYCODE_DPAD_RIGHT",
    ArrowUp: "KEYCODE_DPAD_UP",
    ArrowDown: "KEYCODE_DPAD_DOWN",
    End: "KEYCODE_MOVE_END",
    PageUp: "KEYCODE_PAGE_UP",
    PageDown: "KEYCODE_PAGE_DOWN",
  }),
);

const serialSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?!-)[A-Za-z0-9_.:[\]-]+$/);

function executable(path: string): boolean {
  try {
    const stat = statSync(path);

    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Matches the pinned agent-device SDK roots, then its inherited PATH; never installs or connects. */
function adbPath(env: ToolEnv): string {
  const home = env["HOME"]?.trim() || env["USERPROFILE"]?.trim();

  const roots = [
    env["ANDROID_SDK_ROOT"]?.trim(),
    env["ANDROID_HOME"]?.trim(),
    ...(home && process.platform === "darwin" ? [join(home, "Library", "Android", "sdk")] : []),
    ...(home ? [join(home, "Android", "Sdk")] : []),
  ];

  const name = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = roots.flatMap((root) => (root ? [resolve(root, "platform-tools", name)] : []));
  const entries = (env["PATH"] ?? env["Path"] ?? "").split(delimiter);

  for (const entry of entries) {
    if (entry.trim()) candidates.push(resolve(entry.trim(), name));
  }

  const found = candidates.find(executable);

  if (!found) throw new Error("Android editing keys require an existing Android SDK platform-tools adb or adb on PATH");

  return found;
}

function selectedDevice(stdout: string, serial: string): boolean {
  const entries = stdout.split(/\r?\n/).flatMap((line) => {
    const [id, state] = line.trim().split(/\s+/);

    return id === serial ? [state] : [];
  });

  return entries.length === 1 && entries[0] === "device";
}

/** Returns false for keys handled by DeviceInput; editing accepts one fixed Android key only. */
export async function deviceKey(runtime: DeviceKeyRuntime, input: AgentPreviewInput): Promise<boolean> {
  const key = KEYS.get(input.key);

  if (input.kind !== "key-down" || !key) return false;

  if (input.modifiers) throw new Error("Device preview does not support modified keyboard shortcuts");

  if (runtime.scope.tool !== AgentTool.DEVICE) throw new Error("Device editing requires a device preview");

  // The pinned Apple CLI sets textEntryMode=append: control text can fail verification and trigger repair.
  // Replacing the field through fill cannot preserve its cursor or selection either.
  if (runtime.scope.platform !== "android")
    throw new Error("Editing keys are available only for Android. Use the device’s on-screen keyboard.");
  const parsed = serialSchema.safeParse(runtime.scope.deviceId);

  if (!parsed.success) throw new Error("Select a valid Android device before using editing keys");
  const serial = parsed.data;
  const { env } = installEnv(runtime.env);
  const adb = adbPath(env);
  const signal = runtime.signal;
  signal.throwIfAborted();

  await serializeAgentTool(
    "operations",
    async () => {
      signal.throwIfAborted();

      const run = (args: readonly string[]) =>
        runProcess(
          {
            argv: [adb, ...args],
            env,
            signal,
            timeoutMs: 4_000,
            maxBytes: 64 * 1024,
          },
          { kind: "utility", maxQueueMs: 1_000, signal },
        );

      const inventory = await run(["devices", "-l"]);
      signal.throwIfAborted();

      if (inventory.code !== 0) throw new Error("Could not verify the selected Android device");

      if (!selectedDevice(inventory.stdout, serial))
        throw new Error(
          "The selected Android device is unavailable or unauthorized; reconnect it and reopen the preview",
        );
      const result = await run(["-s", serial, "shell", "input", "keyevent", key]);
      signal.throwIfAborted();

      if (result.code !== 0) throw new Error("The selected Android device rejected the editing key");
    },
    1_000,
  );

  return true;
}
