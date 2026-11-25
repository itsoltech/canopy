import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { agentCursor } from "@canopy/ui/agent-cursor";
import { z } from "zod";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";
import type { DesktopCursorSample } from "./desktop-cursor.ts";
import { readDesktopOverlay } from "./desktop-overlay.ts";
import { showMacDesktopPointer } from "./desktop-pointer-macos.ts";
import { DesktopPointerPreferences } from "./desktop-pointer-preferences.ts";
import type { DesktopPointerStyle } from "./desktop-pointer-types.ts";
import type { ToolEnv } from "./paths.ts";
import { serializeAgentTool } from "./queue.ts";

type NativeCall = Parameters<NonNullable<LocalAutomationServer["managed"]>["call"]>[2];

const enable = "desktop_cursor_overlay_enable";
const disable = "desktop_cursor_overlay_disable";
const color = z.string().regex(/^#[0-9a-f]{6}$/i);

const options = z.strictObject({
  accent: color.default(agentCursor.fill),
  fill: color.optional(),
  rim: color.default(agentCursor.rim),
  size: z.number().min(0.5).max(4).default(1),
  travel_ms: z
    .string()
    .regex(/^\s*\d{1,3}\s*,\s*\d{1,3}\s*$/)
    .default("150,350"),
  no_ripple: z.boolean().default(false),
});

function styleFor(args: AutomationCall["arguments"]): DesktopPointerStyle | undefined {
  const parsed = options.safeParse(args);

  if (!parsed.success) return undefined;
  const { accent, fill, rim, size, travel_ms, no_ripple } = parsed.data;
  const [travelMinMs = 0, travelMaxMs = 0] = travel_ms.split(",").map(Number);

  if (travelMinMs < 30 || travelMinMs > travelMaxMs || travelMaxMs > 700) return undefined;

  return { accent, fill: fill ?? accent, rim, size, travelMinMs, travelMaxMs, ripple: !no_ripple };
}

/** The upstream presentation is global. Advertise the options supported by the window-scoped renderer. */
export function desktopPointerCatalog(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    if (tool.name === disable)
      return {
        ...tool,
        description: `${tool.description ?? ""} Hides the cursor on the worker and in Desktop Preview.`,
      };

    if (tool.name !== enable) return tool;

    const properties = Object.fromEntries(
      Object.entries(tool.inputSchema.properties ?? {}).filter(([key]) => Object.hasOwn(options.shape, key)),
    );

    properties["accent"] = { type: "string", description: "Hex color for the macOS pointer and click ring." };
    properties["travel_ms"] = {
      type: "string",
      description: "Short and long travel time in ms, e.g. 150,350 (30–700).",
    };

    return {
      ...tool,
      description: `${tool.description ?? ""} Desktop Preview can follow background actions. On macOS the worker draws the cursor over the visible target window. Works with physical input off.`,
      inputSchema: { ...tool.inputSchema, properties, additionalProperties: false },
    };
  });
}

const nativeDisabled = z.object({
  ok: z.literal(true),
  command: z.literal("cursor-overlay"),
  data: z.object({ session_id: z.string(), cursor_overlay: z.object({ enabled: z.literal(false) }) }),
});

interface Marker {
  sample: DesktopCursorSample;
  controller: AbortController;
}

export class DesktopPointerPresentation {
  readonly #preferences: DesktopPointerPreferences;
  readonly #markers = new Map<string, Marker>();
  readonly #changes = new Set<{ session: string; controller: AbortController }>();

  constructor(dataDir: string) {
    this.#preferences = new DesktopPointerPreferences(dataDir);
  }

  settings(session: string) {
    return this.#preferences.get(session);
  }

  #change<T>(session: string, signal: AbortSignal, apply: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const change = { session, controller: new AbortController() };
    this.#changes.add(change);
    const request = AbortSignal.any([signal, change.controller.signal]);

    // A late native disable must never restore a preference after another toggle or archive.
    return serializeAgentTool(`desktop-pointer:${session}`, () => {
      request.throwIfAborted();

      return apply(request);
    }).finally(() => this.#changes.delete(change));
  }

  async #retireLegacy(session: string, signal: AbortSignal, next: NativeCall, env: ToolEnv): Promise<void> {
    const previous = readDesktopOverlay(session, env);

    if (!previous) return;
    const result = await next({ name: disable, arguments: {} }, signal);

    if (result?.isError || nativeDisabled.safeParse(result?.structuredContent).data?.data.session_id !== session)
      throw new Error("Agent Desktop could not hide its previous system-wide cursor");
    signal.throwIfAborted();

    if (!this.settings(session)) this.#preferences.set(session, styleFor({ no_ripple: !previous.ripple }));
  }

  disableLegacy(session: string, signal: AbortSignal, next: NativeCall, env: ToolEnv): Promise<void> {
    return this.#change(session, signal, (request) => this.#retireLegacy(session, request, next, env));
  }

  configure(
    session: string,
    params: AutomationCall,
    signal: AbortSignal,
    next: NativeCall,
    env: ToolEnv,
  ): Promise<CallToolResult> {
    return this.#change(session, signal, async (request) => {
      await this.#retireLegacy(session, request, next, env);
      request.throwIfAborted();

      return this.#configure(session, params);
    });
  }

  #configure(session: string, params: AutomationCall): CallToolResult {
    const enabled = params.name === enable;
    const style = enabled ? styleFor(params.arguments) : undefined;

    if (enabled && !style) {
      const error = {
        code: "INVALID_ARGS",
        message: "Use accent, fill, rim, size, travel_ms or no_ripple. Travel times must be 30–700 ms, shortest first.",
      };

      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
        structuredContent: { ok: false, error },
      };
    }

    this.#preferences.set(session, style);
    this.hide(session);

    const data = {
      session_id: session,
      cursor_overlay: { enabled },
      desktop: enabled && process.platform === "darwin" ? "visible_target_window" : "off",
      ...(process.platform !== "darwin" && { rendered: false }),
      preview: enabled,
    };

    const response = { ok: true, command: "cursor-overlay", data };

    return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
  }

  show(session: string, sample: DesktopCursorSample): void {
    if (process.platform !== "darwin") return;
    const style = this.settings(session);

    if (!style) return;
    const previous = this.#markers.get(session)?.sample;
    this.hide(session);
    const controller = new AbortController();
    this.#markers.set(session, { sample, controller });

    const sameWindow =
      previous?.identity.id === sample.identity.id &&
      previous.identity.pid === sample.identity.pid &&
      previous.identity.process_instance === sample.identity.process_instance;

    void showMacDesktopPointer(
      {
        windowId: sample.identity.id,
        pid: sample.identity.pid,
        processInstance: sample.identity.process_instance,
        width: sample.width,
        height: sample.height,
        x: sample.x,
        y: sample.y,
        click: sample.click,
        style,
        ...(sameWindow && { from: { x: previous.x, y: previous.y } }),
      },
      controller.signal,
    ).catch(() => {});
  }

  hide(session: string): void {
    this.#markers.get(session)?.controller.abort();
    this.#markers.delete(session);
  }

  end(session: string): void {
    for (const change of this.#changes) if (change.session === session) change.controller.abort();
    this.hide(session);
    this.#preferences.set(session, undefined);
  }

  close(): void {
    for (const change of this.#changes) change.controller.abort();

    for (const session of this.#markers.keys()) this.hide(session);
  }
}
