import { isJsonObject, parseJson, type JsonValue } from "../json.ts";
import { VISUAL_LIMITS } from "./limits.ts";
import { parseFrameMessage, RateWindow, type FrameMessage, type HostMessage } from "./protocol.ts";
import { validVisualState } from "./semantics.ts";
import type { VisualStateDomain } from "./types.ts";

/**
 * Host side of one mounted visual (docs/agent-visuals.md §4), shared by the web iframe and the mobile WebView:
 * every frame message is rate-limited, parsed and, for local state, checked against the spec before the host
 * acts on it. Anything else is dropped without a reply.
 */
export class VisualFrameInbox {
  private readonly messages = new RateWindow(VISUAL_LIMITS.messagesPerSecond);
  // One extra height per second for the `ready` that opens the channel.
  private readonly heights = new RateWindow(VISUAL_LIMITS.heightsPerSecond + 1);
  private readonly hovers = new RateWindow(VISUAL_LIMITS.hoversPerSecond);

  constructor(
    private readonly domains: ReadonlyMap<string, VisualStateDomain>,
    private readonly htmlDocument = false,
  ) {}

  receive(data: JsonValue, now: number): FrameMessage | undefined {
    if (!this.messages.allow(now)) return undefined;
    let message: FrameMessage | undefined;

    // MessagePort uses structured clone, which can carry cycles or values outside JSON.
    try {
      message = parseFrameMessage(data);
    } catch {
      return undefined;
    }

    switch (message?.type) {
      case "ready":
      case "height":
        return this.heights.allow(now) ? message : undefined;
      case "hover":
        return this.hovers.allow(now) ? message : undefined;
      case "local_state":
        return !this.htmlDocument && validVisualState(this.domains, message.state) ? message : undefined;
      default:
        return message;
    }
  }
}

/**
 * Mobile: the WebView holds a trusted shell that mounts the visual in a sandboxed iframe and relays its port. The
 * native bridge may be reachable from every frame, so each relayed message carries a per-mount token that only the
 * shell knows; the native side drops whatever lacks it. The same envelope carries host messages into the shell.
 */
const SHELL_KEY = "canopy_shell";

/** The envelope adds the token and a few bytes of JSON around a frame message of at most `messageBytes`. */
export const SHELL_MESSAGE_CHARS = VISUAL_LIMITS.messageBytes + 256;

export function shellEnvelope(token: string, message: HostMessage | JsonValue): string {
  return JSON.stringify({ [SHELL_KEY]: token, message });
}

/** The relayed message, only when the raw string is small, well-formed and carries this mount's token. */
export function openShellEnvelope(raw: string, token: string): JsonValue | undefined {
  if (raw.length > SHELL_MESSAGE_CHARS) return undefined;
  const envelope = parseJson(raw);

  if (!isJsonObject(envelope) || envelope[SHELL_KEY] !== token || !token) return undefined;

  return envelope["message"];
}
