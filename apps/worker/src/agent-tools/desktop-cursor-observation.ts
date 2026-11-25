import { str } from "@canopy/domain/json";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { requestDeadline } from "../agent-tools-mcp/protocol.ts";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import type { ToolEnv } from "./paths.ts";
import {
  desktopPoint as point,
  desktopWindowBounds,
  nativeData,
  observeDesktopWindows,
  readDesktopRef,
  resolveDesktopTarget,
  verifiedDesktopWindow,
  type DesktopNativeCall,
  type DesktopTarget,
  type DesktopWindowProof,
  type WindowIdentity,
} from "./desktop-window.ts";

type Point = z.infer<typeof point>;

type Bounds = z.infer<typeof desktopWindowBounds>;

const LIVE_BOUNDS = z.object({
  property: z.literal("bounds"),
  ref: z.string(),
  live: z.literal(true),
  value: desktopWindowBounds,
});

const pointer = z.object({ kind: z.literal("pointer"), point });
const drag = z.object({ kind: z.literal("drag"), to: point });

const report = z.object({
  disposition: z.object({ delivery: z.enum(["delivered_verified", "delivered_unverified"]) }),
  target: z.discriminatedUnion("kind", [pointer, drag]).optional().catch(undefined),
});

const clicks = new Set(["click", "right-click", "double-click", "triple-click"]);

const refActions = new Set([
  "click",
  "right-click",
  "double-click",
  "triple-click",
  "type",
  "set-value",
  "clear",
  "focus",
  "check",
  "uncheck",
  "toggle",
  "expand",
  "collapse",
  "select",
  "scroll",
  "scroll-to",
]);

const physicalActions = new Set(["hover", "drag", "mouse-click", "mouse-move", "mouse-wheel"]);

export function cursorCommand(name: string, headed: boolean): string | undefined {
  if (!name.startsWith("desktop_")) return undefined;
  const command = name.slice("desktop_".length).replaceAll("_", "-");

  return refActions.has(command) || (headed && physicalActions.has(command)) ? command : undefined;
}

const delivered = z.union([report, z.object({ after_action: report }).transform((value) => value.after_action)]);

const possiblySent = z.object({
  disposition: z.object({ delivery: z.enum(["delivered_verified", "delivered_unverified", "delivery_uncertain"]) }),
});

export function desktopActionReport(command: string, result: CallToolResult | undefined) {
  const envelope = result?.structuredContent;

  if (!envelope || envelope["command"] !== command) return undefined;

  // A failing post-action wait may explicitly report that the input was already sent.
  if (result.isError || envelope["ok"] === false)
    return possiblySent.safeParse(envelope["error"]).success ? "hide" : undefined;

  return delivered.safeParse(nativeData(result, command)).data;
}

const ended = z.object({ session_id: z.string(), ended_at: z.number().int().nonnegative() });

export function desktopSessionEnded(session: string, result: CallToolResult | undefined): boolean {
  return ended.safeParse(nativeData(result, "session")).data?.session_id === session;
}

const entries = z.object({
  results: z
    .array(
      z.object({
        command: z.string(),
        ok: z.boolean(),
        data: z.union([ended, delivered]).optional().catch(undefined),
        error: possiblySent.optional().catch(undefined),
      }),
    )
    .max(64),
});

export function desktopBatchEffect(session: string, result: CallToolResult | undefined): "end" | "hide" | undefined {
  const batch = entries.safeParse(nativeData(result, "batch"));

  if (!batch.success) return undefined;

  if (
    batch.data.results.some(
      (item) =>
        item.ok &&
        item.command === "session" &&
        item.data &&
        "session_id" in item.data &&
        item.data.session_id === session,
    )
  )
    return "end";

  const moved = batch.data.results.some(
    (item) => (item.ok ? item.data : item.error) && (refActions.has(item.command) || physicalActions.has(item.command)),
  );

  return moved ? "hide" : undefined;
}

function contains(rect: Bounds, position: Point): boolean {
  return (
    position.x >= rect.x &&
    position.x < rect.x + rect.width &&
    position.y >= rect.y &&
    position.y < rect.y + rect.height
  );
}

interface Observation {
  target: DesktopTarget;
  window: Bounds;
  position: Point | undefined;
}

async function observeWindow(proof: DesktopWindowProof, next: DesktopNativeCall, signal: AbortSignal) {
  const windows = await observeDesktopWindows(next, signal, proof.app);
  const target = windows && resolveDesktopTarget(windows, proof);
  const win = windows && target && verifiedDesktopWindow(windows, target);

  return target && win?.accessible && win.bounds ? { target, window: win.bounds } : undefined;
}

/** Only scoped, read-only observations of an authorized action. Nothing from these replies is forwarded. */
export async function observeDesktopCursor(
  session: string,
  env: ToolEnv,
  command: string,
  args: AutomationCall["arguments"],
  next: DesktopNativeCall,
  signal: AbortSignal,
): Promise<Observation | undefined> {
  if (physicalActions.has(command) && command !== "hover" && command !== "drag") return undefined;
  const ref = str(args[command === "drag" ? "to" : "ref_id"]);
  const source = readDesktopRef(session, env, ref);

  // A raw XY result identifies only a screen point. Native list-windows can omit covering menus and panels.
  if (!source) return undefined;
  const physical = physicalActions.has(command);
  const timeout = requestDeadline([signal], 1_500);

  try {
    const [window, element] = await Promise.allSettled([
      observeWindow(source, next, timeout.signal),
      !physical
        ? next({ name: "desktop_get", arguments: { ref_id: ref, property: "bounds" } }, timeout.signal)
        : undefined,
    ]);

    if (window.status !== "fulfilled" || !window.value || element.status !== "fulfilled" || timeout.signal.aborted)
      return undefined;
    let position: Point | undefined;

    if (!physical) {
      const live = LIVE_BOUNDS.safeParse(nativeData(element.value, "get"));

      // A non-live get can return a stored, window-relative rectangle without tagging its space.
      if (!live.success || live.data.ref !== ref) return undefined;
      const rect = live.data.value;
      position = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }

    return { ...window.value, position };
  } finally {
    timeout.dispose();
  }
}

export interface DesktopCursorLocation {
  identity: WindowIdentity;
  width: number;
  height: number;
  x: number;
  y: number;
  click: boolean;
}

export async function deliveredDesktopCursor(
  command: string,
  outcome: z.infer<typeof report>,
  before: Observation,
  next: DesktopNativeCall,
  signal: AbortSignal,
): Promise<DesktopCursorLocation | undefined> {
  const target = outcome.target;
  let position = before.position;

  if (command === "drag" && target?.kind === "drag") position = target.to;

  if (command === "hover" && target?.kind === "pointer") position = target.point;

  if (!position || !contains(before.window, position)) return undefined;

  if (physicalActions.has(command) || before.target.unique) {
    // Physical input can move the window. A process-owned ref additionally requires a unique window after delivery.
    const windows = await observeDesktopWindows(next, signal, before.target.app);
    const win = windows && verifiedDesktopWindow(windows, before.target);
    const after = win?.accessible && win.bounds;

    if (
      !after ||
      after.x !== before.window.x ||
      after.y !== before.window.y ||
      after.width !== before.window.width ||
      after.height !== before.window.height
    )
      return undefined;
  }

  const { width, height } = before.window;

  return {
    identity: before.target.identity,
    width,
    height,
    x: (position.x - before.window.x) / width,
    y: (position.y - before.window.y) / height,
    click: clicks.has(command),
  };
}
