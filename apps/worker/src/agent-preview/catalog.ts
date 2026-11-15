import { z } from "zod";
import type { AgentPreviewTargetSchema } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { PreviewRuntime } from "./runtime.ts";

export type PreviewTarget = MessageInitShape<typeof AgentPreviewTargetSchema>;

const label = z.string().max(4096);

const selector = z
  .string()
  .min(1)
  .max(16384)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
  );

const bounds = z.object({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  width: z.number().positive().max(8192),
  height: z.number().positive().max(8192),
});

const windows = z
  .array(
    z.object({
      id: selector,
      title: label,
      app_name: label,
      is_focused: z.boolean().default(false),
      accessible: z.boolean().default(true),
      bounds: bounds.nullable().optional(),
    }),
  )
  .max(2048);

export class DesktopCatalog {
  readonly #runtime: PreviewRuntime;
  #window: z.infer<typeof windows>[number] | undefined;

  constructor(runtime: PreviewRuntime) {
    this.#runtime = runtime;
  }

  get selected(): boolean {
    return Boolean(this.#window);
  }

  async refresh() {
    const found = windows.parse(await this.#runtime.command(["list-windows"]));
    const scope = this.#runtime.scope;
    const candidates = found.filter((window) => window.accessible && (!scope.app || window.app_name === scope.app));

    const selected = scope.windowId
      ? candidates.find((window) => window.id === scope.windowId)
      : candidates.find((window) => window.is_focused);

    this.#window = selected;

    if (selected) scope.windowId = selected.id;

    return {
      targetId: selected?.id ?? "",
      title: selected ? `${selected.app_name} — ${selected.title}`.slice(0, 4096) : "Choose a window",
      detail: selected ? "" : "Choose an accessible window to start the preview",
      targets: found.slice(0, 64).map((window): PreviewTarget => ({
        id: window.id,
        label: `${window.app_name} — ${window.title}`.slice(0, 400),
        app: window.app_name,
        windowId: window.id,
        active: window.id === selected?.id,
      })),
    };
  }

  point(x: number, y: number) {
    const rect = this.#window?.bounds;

    if (!rect) throw new Error("The selected window has no global coordinates; pointer input is unavailable");

    return { x: rect.x + x * Math.max(0, rect.width - 1), y: rect.y + y * Math.max(0, rect.height - 1) };
  }

  scopeArgs(): string[] {
    return ["--window-id", this.#runtime.scope.windowId];
  }

  logicalSize() {
    const rect = this.#window?.bounds;

    return rect ? { width: rect.width, height: rect.height } : undefined;
  }
}

const deviceSchema = z.object({
  id: selector,
  name: label,
  platform: z.enum(["ios", "android", "harmonyos", "vega", "macos", "linux", "web", "apple"]),
  appleOs: z.string().optional(),
  booted: z.boolean().optional(),
});

const devicesSchema = z.object({ devices: z.array(deviceSchema).max(2048) });

const sessionsSchema = z.object({
  sessions: z.array(z.object({ name: z.string(), id: z.string(), platform: z.string() })).max(2048),
});

export async function deviceCatalog(runtime: PreviewRuntime) {
  const sessions = sessionsSchema.parse(await runtime.command(["session", "list"])).sessions;
  const devices = devicesSchema.parse(await runtime.command(["devices"])).devices;
  const active = sessions.find((session) => session.name === runtime.scope.session);
  const matching = devices.filter((device) => !runtime.scope.platform || device.platform === runtime.scope.platform);

  const selected = runtime.scope.deviceId
    ? matching.find((device) => device.id === runtime.scope.deviceId)
    : (matching.find((device) => device.id === active?.id) ?? (matching.length === 1 ? matching[0] : undefined));

  if (selected) {
    runtime.scope.platform = selected.platform;
    runtime.scope.deviceId = selected.id;
    runtime.selectDeviceName(selected.name);
  }

  return {
    selected: Boolean(selected),
    targetId: selected ? `${selected.platform}:${selected.id}` : "",
    title: selected?.name ?? "Choose a device",
    detail: selected ? "" : "Choose an available device to start the preview",
    targets: devices.slice(0, 64).map((device): PreviewTarget => ({
      id: `${device.platform}:${device.id}`,
      label: `${device.name} (${device.platform})`.slice(0, 400),
      deviceId: device.id,
      platform: device.platform,
      active: device.id === selected?.id && device.platform === selected.platform,
    })),
  };
}
