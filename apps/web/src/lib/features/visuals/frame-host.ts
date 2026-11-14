import type { JsonValue } from "@canopy/domain";
import {
  clampVisualHeight,
  connectMessage,
  REVOKED_VISUAL_KITS,
  VISUAL_KIT_VERSION,
  VISUAL_LIMITS,
  VisualFrameInbox,
  type HostMessage,
} from "@canopy/domain/visuals";
import { Result } from "effect";
import { reportEmbedHover } from "#lib/shared/ui/virtual/embed-hover.ts";
import { savedVisualState, saveVisualState } from "./visual-state.ts";
import { currentVisualTheme, onVisualThemeChange, prefersReducedMotion } from "./visual-theme.ts";

export interface FrameOptions {
  readonly title: string;
  readonly visualId: string;
  readonly version: number;
  readonly kitVersion: number;
  readonly specJson: string;
  readonly maxHeight: number;
  readonly onHeight: (height: number) => void;
  readonly onError: (message: string) => void;
  /** Escape pressed inside the frame; the only key a frame forwards. */
  readonly onEscape?: (() => void) | undefined;
}

export interface FrameHandle {
  readonly frame: HTMLIFrameElement;
  visible(visible: boolean): void;
  reset(): void;
  destroy(): void;
}

export class VisualUnavailable extends Error {}

/**
 * Mounts a compiled visual in an opaque-origin sandbox (docs/agent-visuals.md §4): `allow-scripts` only, no
 * same-origin, forms, popups, navigation or downloads. The document's own CSP blocks every load. The host hands one
 * MessagePort to this frame's window after load, then trusts nothing but parsed, rate-limited port messages.
 */
export async function mountVisualFrame(container: HTMLElement, options: FrameOptions): Promise<FrameHandle> {
  if (options.kitVersion > VISUAL_KIT_VERSION || REVOKED_VISUAL_KITS.has(options.kitVersion))
    throw new VisualUnavailable("Update Canopy to open this visual.");

  const [{ compileVisual, visualToken }, { parseVisualSpec }] = await Promise.all([
    import("@canopy/domain/visual-compiler"),
    import("@canopy/domain/visuals"),
  ]);

  const decoded = parseVisualSpec(options.specJson);

  if (Result.isFailure(decoded)) throw new VisualUnavailable("Couldn't open this visual.");
  const nonce = visualToken();
  const instance = crypto.randomUUID();

  const html = compileVisual(decoded.success, {
    title: options.title,
    mode: "frame",
    nonce,
    instance,
    theme: currentVisualTheme(),
    reducedMotion: prefersReducedMotion(),
    ...(savedVisualState(options.visualId, options.version) && {
      state: savedVisualState(options.visualId, options.version),
    }),
  });

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");
  frame.title = options.title;
  frame.className = "block w-full border-0 bg-transparent";
  frame.style.height = `${clampVisualHeight(VISUAL_LIMITS.defaultHeight, options.maxHeight)}px`;
  frame.srcdoc = html;

  const channel = new MessageChannel();
  const inbox = new VisualFrameInbox(decoded.success.domains);
  let connected = false;
  let pendingHeight: number | undefined;
  let frameRequest = 0;
  const post = (message: HostMessage) => channel.port1.postMessage(message);

  const applyHeight = () => {
    frameRequest = 0;

    if (pendingHeight === undefined) return;
    const height = clampVisualHeight(pendingHeight, options.maxHeight);
    pendingHeight = undefined;
    frame.style.height = `${height}px`;
    options.onHeight(height);
  };

  channel.port1.onmessage = (event: MessageEvent<JsonValue>) => {
    const message = inbox.receive(event.data, performance.now());

    switch (message?.type) {
      case "ready":
      case "height":
        pendingHeight = message.height;
        frameRequest ||= requestAnimationFrame(applyHeight);

        return;
      case "local_state":
        saveVisualState(options.visualId, options.version, message.state);

        return;
      case "render_error":
        options.onError("Couldn't open this visual.");

        return;
      case "escape":
        options.onEscape?.();

        return;
      case "hover":
        reportEmbedHover(frame, message.inside);

        return;
    }
  };

  // Exactly one handshake, to this frame's window; a document the frame loads later never gets a port.
  frame.addEventListener("load", () => {
    if (connected || !frame.contentWindow) return;
    connected = true;
    frame.contentWindow.postMessage(connectMessage(instance, nonce), "*", [channel.port2]);
  });

  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const onMotion = () => post({ type: "reduced_motion", reduced: motion.matches });
  let themed = 0;

  const stopTheme = onVisualThemeChange(() => {
    themed ||= requestAnimationFrame(() => {
      themed = 0;
      post({ type: "theme", theme: currentVisualTheme() });
    });
  });

  motion.addEventListener("change", onMotion);
  container.append(frame);

  return {
    frame,
    visible: (visible) => post({ type: "visibility", visible }),
    reset: () => post({ type: "reset" }),
    destroy() {
      cancelAnimationFrame(frameRequest);
      cancelAnimationFrame(themed);
      stopTheme();
      motion.removeEventListener("change", onMotion);
      channel.port1.onmessage = null;
      channel.port1.close();
      reportEmbedHover(frame, false);
      frame.remove();
    },
  };
}
