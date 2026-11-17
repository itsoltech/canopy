import { AgentTool } from "@canopy/contracts";
import { runProcess } from "@canopy/process-governor";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { installEnv, redactLine } from "../cli-tools/installer.ts";
import { DeviceBootNotStartedError, type DevicePoolBackend } from "./device-pool.ts";
import { toolArgv, toolCandidates, toolEnvironment } from "./paths.ts";
import { agentToolVersion, type AgentToolProbe } from "./probe.ts";
import { agentToolSpec, safeArgument } from "./specs.ts";

type Device = Awaited<ReturnType<DevicePoolBackend["devices"]>>[number];

const spec = agentToolSpec(AgentTool.DEVICE);
const controlSession = "canopy-device-pool";
const startupMs = 120_000;

const identity = {
  id: z.string().min(1),
  platform: z.string().min(1),
  kind: z.enum(["emulator", "simulator", "device"]),
};

const inventory = z.object({
  devices: z.array(
    z.object({
      ...identity,
      name: z.string().min(1),
      booted: z.boolean().optional(),
      claimedBy: z.object({ session: z.string(), workspace: z.string() }).optional(),
    }),
  ),
});

const sessions = z.object({ sessions: z.array(z.object({ id: z.string(), platform: z.string() })) });

const envelope = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), data: z.json() }),
  z.object({ success: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

const bootResult = z.object({ ...identity, device: z.string(), booted: z.literal(true) });
const shutdownResult = z.object({ ...identity, shutdown: z.object({ success: z.literal(true) }) });

interface DeviceCommand {
  run(args: string[], signal: AbortSignal, timeoutMs?: number): Promise<z.infer<typeof envelope>>;
}

async function resolveCommand(probe: AgentToolProbe, signal: AbortSignal): Promise<DeviceCommand> {
  const source = probe.env ?? process.env;
  const env = toolEnvironment(source, probe.platform);
  const { secrets } = installEnv(source);
  const candidates = toolCandidates(spec, source, probe.platform ?? process.platform, probe.dataDir, probe.which);

  for (const path of candidates.slice(0, 8)) {
    signal.throwIfAborted();
    const version = await (probe.version?.(path) ?? agentToolVersion(path, source, signal));

    if (!("line" in version) || version.line.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/)?.[0] !== spec.version)
      continue;

    return {
      async run(args, commandSignal, timeoutMs = 20_000) {
        commandSignal.throwIfAborted();
        // Offline daemon status reads registration files and rejects transport flags.
        const transport = args[0] === "daemon" ? [] : ["--daemon-transport", "socket"];

        const result = await runProcess(
          {
            argv: toolArgv(path, ["--json", ...transport, ...args], env),
            env,
            signal: commandSignal,
            timeoutMs,
            maxBytes: 1024 * 1024,
          },
          { kind: "utility", maxQueueMs: 2_500, signal: commandSignal },
        );

        commandSignal.throwIfAborted();
        const response = envelope.parse(JSON.parse(result.stdout));

        if (result.code !== 0 && response.success)
          throw new Error("agent-device exited without completing the command");

        if (!response.success) response.error.message = redactLine(response.error.message, secrets);

        return response;
      },
    };
  }

  throw new Error(`Device management requires agent-device ${spec.version}`);
}

async function commandData(command: DeviceCommand, args: string[], signal: AbortSignal, timeoutMs?: number) {
  const result = await command.run(args, signal, timeoutMs);

  if (!result.success) throw new Error(`agent-device ${result.error.code}: ${result.error.message}`);

  return result.data;
}

async function listDevices(command: DeviceCommand, signal: AbortSignal): Promise<Device[]> {
  // Naming the control session lists all local sessions, including other workspace defaults.
  const args = ["--session", controlSession];
  const devices = inventory.parse(await commandData(command, [...args, "devices"], signal)).devices;
  const active = sessions.parse(await commandData(command, [...args, "session", "list"], signal)).sessions;

  const local = devices.map((device) => ({
    id: device.id,
    name: device.name,
    platform: device.platform,
    kind: device.kind,
    booted: device.booted === true,
    busy:
      Boolean(device.claimedBy) ||
      active.some((session) => session.id === device.id && session.platform === device.platform),
  }));

  for (const device of local) {
    // Provider identities survive CLI serialization; provider ownership/source metadata does not.
    if (/^[^:]+:(?:ios|android):/.test(device.id))
      throw new Error("The device pool requires local native devices; provider inventory is unsupported");

    if (
      (device.platform === "android" && device.kind === "emulator") ||
      (device.platform === "ios" && device.kind === "simulator")
    )
      requireVirtual(device);
  }

  return local;
}

function requireVirtual(device: Device): void {
  if (
    !(
      (device.platform === "android" && device.kind === "emulator") ||
      (device.platform === "ios" && device.kind === "simulator")
    )
  )
    throw new Error("Device management only starts and stops Android emulators and Apple simulators");

  safeArgument(device.id, "Device id");
  safeArgument(device.name, "Device name");

  const nativeId =
    device.platform === "ios"
      ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device.id)
      : /^(?:emulator-\d+|[A-Za-z0-9_.-]+)$/.test(device.id);

  if (!nativeId) throw new Error("The device pool requires a native simulator UDID or Android AVD identity");
}

function selectors(device: Device): string[] {
  return [
    "--session",
    controlSession,
    "--platform",
    device.platform,
    device.platform === "ios" ? "--udid" : device.id.startsWith("emulator-") ? "--serial" : "--device",
    device.id,
  ];
}

function sameAvd(left: Device, right: Device): boolean {
  const normalize = (name: string) => name.toLowerCase().replaceAll("_", " ").replaceAll(/\s+/g, " ").trim();

  return left.platform === "android" && right.platform === "android" && normalize(left.name) === normalize(right.name);
}

function assertIdentity(expected: Device, actual: z.infer<typeof bootResult>, mayChangeId: boolean): void {
  if (
    actual.platform !== expected.platform ||
    actual.kind !== expected.kind ||
    (!mayChangeId && actual.id !== expected.id)
  )
    throw new Error("agent-device returned a different device than requested");

  if (mayChangeId && (!/^emulator-\d+$/.test(actual.id) || !sameAvd(expected, { ...expected, name: actual.device })))
    throw new Error("agent-device returned a different Android AVD than requested");
}

async function prepareBoot(probe: () => AgentToolProbe, device: Device, signal: AbortSignal): Promise<DeviceCommand> {
  try {
    requireVirtual(device);
    const command = await resolveCommand(probe(), signal);
    const current = await listDevices(command, signal);
    const selected = current.find((candidate) => candidate.platform === device.platform && candidate.id === device.id);

    if (!selected || selected.kind !== device.kind || selected.busy)
      throw new Error("The selected virtual device is unavailable or in use");

    if (
      !device.booted &&
      (selected.booted || current.some((candidate) => sameAvd(device, candidate) && candidate.id !== device.id))
    )
      throw new Error("The selected virtual device was started outside this reservation");

    return command;
  } catch (cause) {
    // No boot command has been dispatched: cleanup must not stop a device another user started.
    throw new DeviceBootNotStartedError(cause instanceof Error ? cause.message : "Device startup was not attempted");
  }
}

async function awaitShutdown(command: DeviceCommand, device: Device, signal: AbortSignal): Promise<void> {
  const confirmation = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

  for (;;) {
    const current = (await listDevices(command, confirmation)).find(
      (candidate) => candidate.platform === device.platform && candidate.id === device.id,
    );

    if (!current || (device.platform === "ios" && !current.booted)) return;
    await setTimeout(200, undefined, { signal: confirmation });
  }
}

/** Pinned CLI adapter; ownership and durable reservations belong to the worker pool. */
export function createDeviceBackend(probe: () => AgentToolProbe): DevicePoolBackend & {
  closeSession(session: string): Promise<void>;
} {
  return {
    async devices(signal) {
      const command = await resolveCommand(probe(), signal);

      return listDevices(command, signal);
    },
    async boot(device, signal) {
      const command = await prepareBoot(probe, device, signal);
      const mayChangeId = device.platform === "android" && !device.id.startsWith("emulator-");
      // The pool returns cancellation promptly, then drains this finite startup before cleanup.
      const startupSignal = AbortSignal.timeout(startupMs + 15_000);

      const result = bootResult.parse(
        await commandData(
          command,
          [
            ...selectors(device),
            "boot",
            ...(device.platform === "android" ? ["--headless"] : []),
            "--timeout",
            String(startupMs),
          ],
          startupSignal,
          startupMs + 15_000,
        ),
      );

      assertIdentity(device, result, mayChangeId);

      return { ...device, id: result.id, name: result.device, booted: true, busy: false };
    },
    async shutdown(device, signal) {
      requireVirtual(device);

      // A persisted AVD config means startup never returned its runtime serial. Inventory
      // cannot distinguish a stopped AVD from one the daemon may still launch after a timeout.
      if (device.platform === "android" && !/^emulator-\d+$/.test(device.id))
        throw new Error("Cannot prove ownership of the Android AVD runtime; retain the reservation for cleanup");

      const command = await resolveCommand(probe(), signal);
      const current = await listDevices(command, signal);

      const selected = current.find(
        (candidate) => candidate.platform === device.platform && candidate.id === device.id,
      );

      if (!selected) {
        if (
          device.platform === "android" &&
          current.some((candidate) => sameAvd(device, candidate) && candidate.id.startsWith("emulator-"))
        )
          throw new Error("Cannot prove ownership of the running Android AVD; retain the reservation for cleanup");

        return;
      }

      if (
        selected.kind !== device.kind ||
        (selected.name !== device.name && !sameAvd(device, selected)) ||
        selected.busy
      )
        throw new Error("Cannot shut down a changed device or a device held by another session");

      // Inventory maps both Shutdown and Booting to false for Apple; let simctl decide.
      if (!selected.booted && device.platform === "android") {
        if (device.id.startsWith("emulator-"))
          throw new Error("The reserved Android emulator is still booting; retain it for cleanup");

        return;
      }

      const result = shutdownResult.parse(
        await commandData(command, [...selectors(device), "shutdown"], signal, 30_000),
      );

      if (result.platform !== device.platform || result.id !== device.id || result.kind !== device.kind)
        throw new Error("agent-device shut down a different device than requested");

      // ADB accepts `emu kill` before the emulator leaves inventory. Keep the lease until it does.
      await awaitShutdown(command, device, signal);
    },
    async closeSession(session) {
      safeArgument(session, "Device session");

      if (!session) throw new Error("Device cleanup requires an explicit session");
      const signal = AbortSignal.timeout(30_000);
      const command = await resolveCommand(probe(), signal);

      const status = z
        .object({ state: z.enum(["running", "stopped", "unreadable", "invalid"]) })
        .parse(await commandData(command, ["daemon", "status"], signal));

      if (status.state === "stopped") return;

      if (status.state !== "running") throw new Error("agent-device daemon registration cannot be read");
      const result = await command.run(["--session", session, "close"], signal);

      if (!result.success && result.error.code !== "SESSION_NOT_FOUND")
        throw new Error(`agent-device ${result.error.code}: ${result.error.message}`);
    },
  };
}
