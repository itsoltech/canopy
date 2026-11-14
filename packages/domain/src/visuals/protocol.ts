import { isJsonObject, isNumber, isString, type JsonObject, type JsonValue } from "../json.ts";
import { VISUAL_LIMITS, VISUAL_PROTOCOL_VERSION } from "./limits.ts";
import { VISUAL_TOKEN_NAMES, validVisualTheme, type VisualTheme } from "./theme-tokens.ts";
import type { VisualSpec, VisualState, VisualStateDomain, VisualStateValue } from "./types.ts";

/**
 * Host ↔ visual channel (docs/agent-visuals.md §4). The host posts one `connect` with a MessagePort to the frame's
 * window; everything else travels over that port. Both sides parse every message and drop what doesn't fit.
 * No import of effect here: the kit bundles this file.
 */

/** Compiled into the document as inert JSON; read by the kit with textContent. */
export interface VisualDocumentData {
  readonly protocol: typeof VISUAL_PROTOCOL_VERSION;
  /** frame: mounted by a Canopy host that connects a port. export: a downloaded file, no host. */
  readonly mode: "frame" | "export";
  readonly instance: string;
  readonly nonce: string;
  readonly spec: VisualSpec;
  readonly domains: readonly (readonly [string, VisualStateDomain])[];
  readonly state: VisualState;
  readonly theme: VisualTheme | null;
  readonly reducedMotion: boolean;
}

export type HostMessage =
  | { readonly type: "theme"; readonly theme: VisualTheme }
  | { readonly type: "visibility"; readonly visible: boolean }
  | { readonly type: "reduced_motion"; readonly reduced: boolean }
  | { readonly type: "reset" };

export type FrameMessage =
  | { readonly type: "ready"; readonly height: number }
  | { readonly type: "height"; readonly height: number }
  | { readonly type: "local_state"; readonly state: VisualState }
  | { readonly type: "render_error"; readonly message: string }
  /** Escape pressed inside the frame, so the host can close its full-screen dialog. No other input is forwarded. */
  | { readonly type: "escape" };

const isBoolean = (value: JsonValue | undefined): value is boolean => typeof value === "boolean";

const isStateValue = (value: JsonValue | undefined): value is VisualStateValue =>
  isString(value) || isBoolean(value) || (isNumber(value) && Number.isInteger(value));

export function connectMessage(instance: string, nonce: string): JsonObject {
  return { canopy_visual: VISUAL_PROTOCOL_VERSION, type: "connect", instance, nonce };
}

/** The handshake the kit accepts once, from its parent window only. */
export function isConnectMessage(data: JsonValue, instance: string, nonce: string): boolean {
  return (
    isJsonObject(data) &&
    data["canopy_visual"] === VISUAL_PROTOCOL_VERSION &&
    data["type"] === "connect" &&
    data["instance"] === instance &&
    data["nonce"] === nonce
  );
}

function parseTheme(value: JsonValue | undefined): VisualTheme | undefined {
  if (!isJsonObject(value) || !isJsonObject(value["colors"])) return undefined;
  const colors = value["colors"];
  const mode = value["mode"];
  const scale = value["scale"];

  if ((mode !== "light" && mode !== "dark") || !isNumber(scale)) return undefined;

  if (!VISUAL_TOKEN_NAMES.every((name) => isString(colors[name]))) return undefined;

  const theme: VisualTheme = {
    mode,
    scale,
    // SAFETY: built from VISUAL_TOKEN_NAMES, so every token key is present exactly once.
    colors: Object.fromEntries(VISUAL_TOKEN_NAMES.map((name) => [name, String(colors[name])])) as VisualTheme["colors"],
  };

  return validVisualTheme(theme) ? theme : undefined;
}

export function parseHostMessage(data: JsonValue): HostMessage | undefined {
  if (!isJsonObject(data)) return undefined;

  switch (data["type"]) {
    case "theme": {
      const theme = parseTheme(data["theme"]);

      return theme ? { type: "theme", theme } : undefined;
    }

    case "visibility":
      return isBoolean(data["visible"]) ? { type: "visibility", visible: data["visible"] } : undefined;
    case "reduced_motion":
      return isBoolean(data["reduced"]) ? { type: "reduced_motion", reduced: data["reduced"] } : undefined;
    case "reset":
      return { type: "reset" };
    default:
      return undefined;
  }
}

function parseState(value: JsonValue | undefined): VisualState | undefined {
  if (!isJsonObject(value)) return undefined;
  const entries = Object.entries(value);

  if (entries.length > VISUAL_LIMITS.stateKeys || !entries.every(([, v]) => isStateValue(v))) return undefined;

  return Object.fromEntries(entries.flatMap(([key, v]) => (isStateValue(v) ? [[key, v]] : [])));
}

/** Messages from a frame. Sizes and numbers are checked here; state values against the spec by the caller. */
export function parseFrameMessage(data: JsonValue): FrameMessage | undefined {
  if (!isJsonObject(data) || JSON.stringify(data).length > VISUAL_LIMITS.messageBytes) return undefined;
  const height = data["height"];

  switch (data["type"]) {
    case "ready":
    case "height":
      return isNumber(height) && Number.isFinite(height) && height >= 0 && height <= 1_000_000
        ? { type: data["type"], height }
        : undefined;
    case "local_state": {
      const state = parseState(data["state"]);

      return state && JSON.stringify(state).length <= VISUAL_LIMITS.stateBytes
        ? { type: "local_state", state }
        : undefined;
    }

    case "escape":
      return { type: "escape" };
    case "render_error": {
      const message = data["message"];

      return isString(message) ? { type: "render_error", message: String(message).slice(0, 500) } : undefined;
    }

    default:
      return undefined;
  }
}

/** A sliding one-second window: at most `limit` events, the rest are dropped. */
export class RateWindow {
  private readonly times: number[] = [];

  constructor(private readonly limit: number) {}

  allow(now: number): boolean {
    while (this.times.length && now - this.times[0]! >= 1000) this.times.shift();

    if (this.times.length >= this.limit) return false;
    this.times.push(now);

    return true;
  }
}

/** Host side: the frame's natural height within the visual's bounds. */
export function clampVisualHeight(height: number, max: number = VISUAL_LIMITS.maxHeight): number {
  return Math.round(Math.min(Math.max(height, VISUAL_LIMITS.minHeight), max));
}
