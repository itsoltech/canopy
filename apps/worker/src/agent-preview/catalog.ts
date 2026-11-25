import { z } from "zod";
import type { AgentPreviewTargetSchema } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { PreviewRuntime } from "./runtime.ts";
import {
  desktopSelector as selector,
  desktopWindows as windows,
  sameDesktopWindow,
  verifiedDesktopWindow,
  type DesktopTarget,
  type DesktopWindow,
} from "../agent-tools/desktop-window.ts";

export type PreviewTarget = MessageInitShape<typeof AgentPreviewTargetSchema>;

const label = z.string().max(4096);

function windowTarget(win: DesktopWindow, selected: DesktopWindow | undefined): PreviewTarget {
  return {
    id: win.id,
    label: `${win.app_name} — ${win.title}`.slice(0, 400),
    app: win.app_name,
    windowId: win.id,
    active: win === selected,
  };
}

function inventory(runtime: PreviewRuntime, app: string | undefined, signal?: AbortSignal) {
  return runtime
    .command(["list-windows", ...(app ? [`--app=${app}`] : []), "--timeout-ms=1500"], {
      timeoutMs: 2_000,
      ...(signal && { signal }),
    })
    .then(
      (data) => windows.safeParse(data).data,
      () => undefined,
    );
}

export async function lookupDesktopTarget(runtime: PreviewRuntime, target: DesktopTarget, signal: AbortSignal) {
  if (runtime.desktopTarget() !== target) return undefined;
  const found = await inventory(runtime, target.app, signal);

  if (!found || signal.aborted || runtime.desktopTarget() !== target) return undefined;
  const win = verifiedDesktopWindow(found, target);

  if (!win) {
    runtime.missingDesktopTarget(target);
    const cursor = runtime.desktopCursor();

    if (cursor && sameDesktopWindow(target.identity, cursor.identity)) runtime.missingCursorWindow(cursor.actionId);
  }

  return win;
}

export class DesktopCatalog {
  readonly #runtime: PreviewRuntime;
  readonly #windowId: string;
  #window: z.infer<typeof windows>[number] | undefined;
  #actionId: string | undefined;

  constructor(runtime: PreviewRuntime) {
    this.#runtime = runtime;
    this.#windowId = runtime.scope.windowId;
  }

  get selected(): boolean {
    return Boolean(this.#window);
  }

  get targetId(): string {
    return this.#window?.id ?? "";
  }

  get cursorChanged(): boolean {
    return this.#actionId !== this.#runtime.desktopCursor()?.actionId;
  }

  cursor() {
    const sample = this.#runtime.desktopCursor();
    const win = this.#window;

    if (!sample || !win?.bounds || !sameDesktopWindow(sample.identity, win)) return undefined;

    if (sample.width !== win.bounds.width || sample.height !== win.bounds.height) return undefined;

    return sample;
  }

  async frameCursor(actionId: string) {
    const sample = this.cursor();

    if (sample?.actionId !== actionId) return undefined;

    const found = await inventory(this.#runtime, this.#window?.app_name);

    if (!found) return undefined;
    const matches = found.filter((item) => sameDesktopWindow(sample.identity, item));
    const win = matches.length === 1 ? matches[0] : undefined;

    if (!win?.accessible) {
      this.#runtime.missingCursorWindow(actionId);

      return undefined;
    }

    if (
      !sameDesktopWindow(sample.identity, win) ||
      win.bounds?.width !== sample.width ||
      win.bounds.height !== sample.height
    )
      return undefined;
    const current = this.cursor();

    return current?.actionId === actionId ? current : undefined;
  }

  async refresh() {
    const initialAction = this.#runtime.desktopCursor()?.actionId;
    const found = windows.parse(await this.#runtime.command(["list-windows"]));
    const scope = this.#runtime.scope;
    const fallbackApp = scope.app || this.#runtime.desktopDefaultApp;
    const candidates = found.filter((window) => window.accessible && (!fallbackApp || window.app_name === fallbackApp));
    const cursor = this.#runtime.desktopCursor();

    const cursorWindow =
      cursor && found.find((window) => window.accessible && sameDesktopWindow(cursor.identity, window));

    if (cursor && !cursorWindow && cursor.actionId === initialAction)
      this.#runtime.missingCursorWindow(cursor.actionId);
    this.#actionId = cursorWindow ? cursor?.actionId : undefined;

    const preferred = cursorWindow && (!scope.app || cursorWindow.app_name === scope.app) ? cursorWindow : undefined;

    const selected = this.#windowId
      ? candidates.find((window) => window.id === this.#windowId)
      : (preferred ??
        candidates.find((window) => window.is_focused) ??
        (fallbackApp && candidates.length === 1 ? candidates[0] : undefined));

    this.#window = selected;

    scope.windowId = selected?.id ?? this.#windowId;

    return {
      targetId: selected?.id ?? "",
      title: selected ? `${selected.app_name} — ${selected.title}`.slice(0, 4096) : "Choose a window",
      detail: selected ? "" : "Choose an accessible window to start the preview",
      targets: (selected ? [selected, ...found.filter((win) => win !== selected)] : found)
        .slice(0, 64)
        .map((win) => windowTarget(win, selected)),
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
  kind: z.enum(["emulator", "simulator", "device"]).optional(),
  booted: z.boolean().optional(),
  claimedBy: z.object({ session: z.string(), workspace: z.string() }).optional(),
});

const devicesSchema = z.object({ devices: z.array(deviceSchema).max(2048) });

const sessionsSchema = z.object({
  sessions: z.array(z.object({ name: z.string(), id: z.string(), platform: z.string() })).max(2048),
});

// Runtime selectors resolve commands, while the original selectors retain the viewer's choice.
const deviceScopes = new WeakMap<PreviewRuntime, { platform: string; deviceId: string }>();

function matchesPlatform(platform: string, selected: string): boolean {
  return !selected || platform === selected || (selected === "apple" && ["ios", "macos"].includes(platform));
}

export async function deviceCatalog(runtime: PreviewRuntime) {
  const scope = deviceScopes.get(runtime) ?? { platform: runtime.scope.platform, deviceId: runtime.scope.deviceId };
  deviceScopes.set(runtime, scope);
  const sessions = sessionsSchema.parse(await runtime.command(["session", "list"])).sessions;
  const devices = devicesSchema.parse(await runtime.command(["devices"])).devices;
  const active = sessions.find((session) => session.name === runtime.scope.session);

  const platform =
    scope.platform || (!scope.deviceId && active?.platform) || (!scope.deviceId && runtime.devicePlatform) || "";

  const matching = devices.filter(
    (device) =>
      matchesPlatform(device.platform, platform) &&
      runtime.canPreviewDevice(device.id, device.platform) &&
      (!device.claimedBy || device.claimedBy.session === runtime.scope.session) &&
      !sessions.some(
        (session) =>
          session.name !== runtime.scope.session && session.id === device.id && session.platform === device.platform,
      ) &&
      (active
        ? device.id === active.id && device.platform === active.platform
        : device.kind === "emulator" || device.kind === "simulator"
          ? device.booted === true
          : device.booted !== false),
  );

  const selected = scope.deviceId
    ? matching.find((device) => device.id === scope.deviceId)
    : (matching.find((device) => device.id === active?.id && device.platform === active?.platform) ??
      (matching.length === 1 ? matching[0] : undefined));

  runtime.scope.platform = selected?.platform ?? scope.platform;
  runtime.scope.deviceId = selected?.id ?? scope.deviceId;
  runtime.selectDeviceName(selected?.name ?? "");

  return {
    selected: Boolean(selected),
    targetId: selected ? `${selected.platform}:${selected.id}` : "",
    title: selected?.name ?? "Choose a device",
    detail: selected ? "" : "Choose an available device to start the preview",
    targets: matching.slice(0, 64).map((device): PreviewTarget => ({
      id: `${device.platform}:${device.id}`,
      label: `${device.name} (${device.platform})`.slice(0, 400),
      deviceId: device.id,
      platform: device.platform,
      active: device.id === selected?.id && device.platform === selected.platform,
    })),
  };
}
