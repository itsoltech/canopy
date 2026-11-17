import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";
import type { Device, DevicePool } from "./device-pool.ts";

const selector = z.object({
  platform: z.string().optional(),
  device: z.string().optional(),
  udid: z.string().optional(),
  serial: z.string().optional(),
});

const acquire = selector.extend({
  boot: z.boolean().default(true),
  timeoutMs: z.number().int().min(1).max(240_000).default(60_000),
});

const steps = z.array(z.object({ command: z.string(), input: z.record(z.string(), z.json()) }).catchall(z.json()));

const instructions =
  "Reserve a device with acquire_device before testing; it waits for a free device and can boot another configured emulator or simulator. release_device when finished. Reservations are exclusive to this thread and shared with Preview. Idle reservations expire after five minutes. Do not bypass reservations using shell/CLI or another session.";

const tools: Tool[] = [
  {
    name: "acquire_device",
    description: instructions,
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["ios", "android", "apple"] },
        device: { type: "string", description: "Optional configured device name or ID." },
        boot: { type: "boolean", default: true, description: "Allow booting a stopped configured virtual device." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 240000, default: 60000 },
      },
    },
  },
  {
    name: "release_device",
    description:
      "Close this thread's device session and release its reservation, shutting down a virtual device started by Canopy.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function deviceSelection(args: AutomationCall["arguments"]) {
  const parsed = selector.parse(args);
  const ids = [parsed.device, parsed.udid, parsed.serial].filter(Boolean);

  if (new Set(ids).size > 1) throw new Error("Choose one device selector");

  return { ...(parsed.platform && { platform: parsed.platform }), ...(ids[0] && { deviceId: ids[0] }) };
}

function bindDevice(args: AutomationCall["arguments"], device: Device): AutomationCall["arguments"] {
  const selected = deviceSelection(args);

  if (selected.deviceId && ![device.id, device.name].includes(selected.deviceId))
    throw new Error("Release the current device before selecting another device");

  if (
    selected.platform &&
    selected.platform !== device.platform &&
    !(selected.platform === "apple" && ["ios", "macos"].includes(device.platform))
  )
    throw new Error("The reserved device uses a different platform");
  const { device: _device, serial: _serial, udid: _udid, ...rest } = args;

  return {
    ...rest,
    platform: device.platform,
    ...(["ios", "macos"].includes(device.platform)
      ? { udid: device.id }
      : ["android", "harmonyos", "vega"].includes(device.platform)
        ? { serial: device.id }
        : { device: device.name }),
  };
}

const result = (value: { device: Device; reserved: boolean } | { released: boolean }): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const discovery = new Set(["devices", "capabilities", "doctor"]);
const lifecycle = new Set(["boot", "shutdown", "release_device", "acquire_device", "replay", "test", "batch", "close"]);

export function managedDeviceMcp(
  pool: DevicePool,
  session: string,
  release: () => Promise<void>,
): NonNullable<LocalAutomationServer["managed"]> {
  return {
    tools,
    catalog: (catalog) =>
      catalog
        .filter((tool) => tool.name !== "replay")
        .map((tool) => ({
          ...tool,
          description: `${tool.description?.replace(/Use replay for each script in this thread\./g, "Execute scripts as individual device tool calls in this thread.") ?? ""}\n${instructions}${tool.name === "shutdown" ? " Shutdown releases this thread's reservation and only stops devices started by Canopy." : ""}`,
        })),
    async call(params, signal, next) {
      if (params.name === "acquire_device" || params.name === "boot") {
        const input = acquire.parse(params.arguments);

        const device = await pool.acquire(
          session,
          { ...deviceSelection(params.arguments), boot: input.boot, timeoutMs: input.timeoutMs },
          signal,
        );

        return result({ device, reserved: true });
      }

      if (params.name === "release_device" || params.name === "shutdown") {
        const current = pool.current(session);

        if (current) bindDevice(params.arguments, current);
        else if (deviceSelection(params.arguments).deviceId) throw new Error("This thread has no reserved device");
        await release();

        return result({ released: true });
      }

      if (discovery.has(params.name)) return next(params, signal);

      if (params.name === "replay")
        throw new Error(
          "Device replay can change devices outside this reservation. Execute its steps through the device tools in this thread.",
        );

      const device = await pool.acquire(
        session,
        { ...deviceSelection(params.arguments), boot: false, wait: false, timeoutMs: 15_000 },
        signal,
      );

      return pool.use(session, device.id, async () => {
        let args = bindDevice(params.arguments, device);

        if (params.name === "batch") {
          args = {
            ...args,
            steps: steps.parse(args["steps"]).map((step) => {
              if (lifecycle.has(step.command))
                throw new Error("Reserve or release devices outside batch; nested batches and replay are unavailable");

              return { ...step, input: bindDevice(step.input, device) };
            }),
          };
        }

        if (params.name === "close" && params.arguments["shutdown"])
          throw new Error("Use release_device to release and shut down a managed device");

        return next({ ...params, arguments: args }, signal);
      });
    },
  };
}
