import { z } from "zod";
import { requestDeadline } from "../agent-tools-mcp/protocol.ts";
import { objectOf, parseObject } from "@canopy/domain/json";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";
import { readDesktopRefMap } from "./desktop-overlay.ts";
import type { ToolEnv } from "./paths.ts";

export type DesktopNativeCall = Parameters<NonNullable<LocalAutomationServer["managed"]>["call"]>[2];

const coordinate = z.number().min(-100_000).max(100_000);
export const desktopPoint = z.object({ x: coordinate, y: coordinate });

export const desktopWindowBounds = desktopPoint.extend({
  width: z.number().positive().max(8192),
  height: z.number().positive().max(8192),
});

export const desktopWindowIdentity = z.object({
  id: z.string().min(1).max(16_384),
  pid: z.number().int().positive(),
  process_instance: z.string().min(1).max(1024),
});

export type WindowIdentity = z.infer<typeof desktopWindowIdentity>;

export function sameDesktopWindow(
  identity: WindowIdentity,
  window: { id: string; pid?: number | undefined; process_instance?: string | undefined },
): boolean {
  return (
    window.id === identity.id && window.pid === identity.pid && window.process_instance === identity.process_instance
  );
}

const refSource = z.object({
  source_window_id: desktopWindowIdentity.shape.id.optional(),
  source_window_title: z.string().nullish(),
  pid: desktopWindowIdentity.shape.pid,
  process_instance: desktopWindowIdentity.shape.process_instance,
  source_app: z.string().max(4096).nullish(),
  // Popovers and menus can be separate surfaces absent from a window screenshot.
  source_surface: z.literal("window").optional(),
});

export const desktopSelector = z
  .string()
  .min(1)
  .max(16_384)
  .refine(
    (value) => !value.startsWith("-") && [...value].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127),
  );

export const desktopWindows = z
  .array(
    z.object({
      id: desktopSelector,
      title: z.string().max(4096),
      app_name: z.string().max(4096),
      is_focused: z.boolean().default(false),
      accessible: z.boolean().default(true),
      pid: desktopWindowIdentity.shape.pid.optional().catch(undefined),
      process_instance: desktopWindowIdentity.shape.process_instance.optional().catch(undefined),
      bounds: desktopWindowBounds.nullish().catch(null),
    }),
  )
  .max(2048);

export type DesktopWindow = z.infer<typeof desktopWindows>[number];

export interface DesktopTarget {
  app: string;
  identity: WindowIdentity;
  /** A process-owned AX tree can identify a window only while that process has exactly one. */
  unique: boolean;
}

export interface DesktopWindowProof {
  app?: string | undefined;
  id?: string | undefined;
  unique?: boolean | undefined;
  pid?: number | undefined;
  process_instance?: string | undefined;
}

function matchingWindows(windows: DesktopWindow[], proof: DesktopWindowProof) {
  return windows.filter(
    (win) =>
      (!proof.app || win.app_name === proof.app) &&
      (!proof.id || win.id === proof.id) &&
      (!proof.pid || (win.pid === proof.pid && win.process_instance === proof.process_instance)),
  );
}

export function resolveDesktopTarget(windows: DesktopWindow[], proof: DesktopWindowProof): DesktopTarget | undefined {
  if (!proof.id && !proof.app) return undefined;
  const unique = proof.unique ?? !proof.id;
  const matches = matchingWindows(windows, { ...proof, id: unique ? undefined : proof.id });
  const win = matches.length === 1 ? matches[0] : undefined;
  const identity = desktopWindowIdentity.safeParse(win).data;

  return win?.app_name && identity && (!proof.id || win.id === proof.id)
    ? { app: win.app_name, identity, unique }
    : undefined;
}

export function verifiedDesktopWindow(windows: DesktopWindow[], target: DesktopTarget) {
  const matches = matchingWindows(windows, {
    ...target.identity,
    id: target.unique ? undefined : target.identity.id,
    app: target.app,
  });

  const win = matches.length === 1 ? matches[0] : undefined;

  return win && sameDesktopWindow(target.identity, win) ? win : undefined;
}

/** Metadata only. An auxiliary AX timeout must never change the authorized tool result or repeat an action. */
export async function observeDesktopWindows(next: DesktopNativeCall, signal: AbortSignal, app: string | undefined) {
  const deadline = requestDeadline([signal], 1_500);

  try {
    const result = await next(
      { name: "desktop_list_windows", arguments: { ...(app && { app }), timeout_ms: 1_500 } },
      deadline.signal,
    );

    return deadline.signal.aborted ? undefined : desktopWindows.safeParse(nativeData(result, "list-windows")).data;
  } catch {
    return undefined;
  } finally {
    deadline.dispose();
  }
}

export const qualifiedDesktopRef = /^@([a-zA-Z0-9_-]{3,64}):(e[1-9][0-9]{0,9})$/;

export function readDesktopRef(session: string, env: ToolEnv, ref: string): DesktopWindowProof | null | undefined {
  const match = qualifiedDesktopRef.exec(ref);

  if (!match) return undefined;
  const json = readDesktopRefMap(session, env, match[1]!);

  if (!json) return undefined;
  const entry = objectOf(parseObject(json)["inner"])[`@${match[2]}`];
  const parsed = refSource.safeParse(entry);

  if (!parsed.success) return entry === undefined ? undefined : null;
  const source = parsed.data;

  if (!source.source_window_id && source.source_window_title !== "") return null;

  return {
    id: source.source_window_id,
    app: source.source_app ?? undefined,
    pid: source.pid,
    process_instance: source.process_instance,
    unique: !source.source_window_id,
  };
}

export function nativeData(result: CallToolResult | undefined, command: string) {
  const envelope = result?.structuredContent;

  return !result?.isError && envelope?.["ok"] === true && envelope["command"] === command
    ? envelope["data"]
    : undefined;
}
