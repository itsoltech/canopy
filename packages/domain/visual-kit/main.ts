import { VISUAL_LIMITS } from "../src/visuals/limits.ts";
import {
  isConnectMessage,
  parseHostMessage,
  type FrameMessage,
  type VisualDocumentData,
} from "../src/visuals/protocol.ts";
import { VISUAL_TOKEN_NAMES, validVisualTheme, type VisualTheme } from "../src/visuals/theme-tokens.ts";
import type { KitContext } from "./context.ts";
import { el } from "./dom.ts";
import { renderNode } from "./render.ts";
import { Store } from "./store.ts";

// Entry point of the trusted kit inside the sandboxed frame. It reads the compiler's inert JSON, renders with DOM APIs
// and talks to the host only over the port handed over in the handshake.

const root = document.documentElement;

function applyTheme(theme: VisualTheme): void {
  if (!validVisualTheme(theme)) return;

  for (const name of VISUAL_TOKEN_NAMES) root.style.setProperty(`--${name}`, theme.colors[name]);
  root.dataset["mode"] = theme.mode;
  root.style.colorScheme = theme.mode;
  root.style.fontSize = `${16 * theme.scale}px`;
}

function readData(): VisualDocumentData {
  const source = document.getElementById("canopy-visual-data");

  // SAFETY: the trusted compiler wrote this block from a validated spec; the frame has no other input.
  return JSON.parse(source?.textContent ?? "null") as VisualDocumentData;
}

/** The natural height: the root plus the body's padding, rounded up so the frame never falls a fraction short. */
function naturalHeight(main: HTMLElement): number {
  const style = getComputedStyle(document.body);

  return Math.ceil(
    main.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
  );
}

/**
 * The document scrolls only when the host caps the frame below the content. A document that can scroll even a pixel
 * takes the wheel for the whole gesture, so the reader's thread would stop under the cursor.
 */
function fitScroll(main: HTMLElement): void {
  root.style.overflowY = naturalHeight(main) > window.innerHeight ? "auto" : "hidden";
}

function heightReporter(main: HTMLElement, send: (message: FrameMessage) => void) {
  let last = 0;
  let pending: number | undefined;
  let reported = -1;
  const interval = 1000 / VISUAL_LIMITS.heightsPerSecond;

  const report = () => {
    pending = undefined;
    const height = naturalHeight(main);

    if (height === reported) return;
    reported = height;
    last = performance.now();
    send({ type: "height", height });
  };

  return () => {
    fitScroll(main);

    if (pending !== undefined) return;
    const wait = Math.max(0, interval - (performance.now() - last));
    pending = window.setTimeout(report, wait);
  };
}

/**
 * Wheel and touch input over the frame stays in the frame while its scroll chains to the host's feed, which tells a
 * reader's scroll from a layout one by its input. So the kit reports whether the pointer is inside, and nothing more:
 * at most `hoversPerSecond`, the last report always the current state. The returned function reports it now.
 */
function hoverReporter(send: (message: FrameMessage) => void): () => void {
  const interval = 1000 / VISUAL_LIMITS.hoversPerSecond;
  let last = -Infinity;
  let pending: number | undefined;
  let inside = false;

  const report = () => {
    pending = undefined;
    last = performance.now();
    send({ type: "hover", inside });
  };

  const update = (next: boolean) => {
    inside = next;

    if (pending === undefined) pending = window.setTimeout(report, Math.max(0, interval - (performance.now() - last)));
  };

  root.addEventListener("pointerenter", () => update(true));
  root.addEventListener("pointerleave", () => update(false));

  return () => update(inside);
}

function boot(): void {
  const data = readData();
  const main = el("main", "v-root");
  const live = el("p", "v-sr");
  const resizers = new Map<Element, () => void>();

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) resizers.get(entry.target)?.();
  });

  let port: MessagePort | undefined;
  const send = (message: FrameMessage) => port?.postMessage(message);
  const store = new Store(data.spec.state ?? {}, new Map(data.domains), data.state);

  const ctx: KitContext = {
    store,
    render: (node) => renderNode(ctx, node),
    announce: (text) => {
      live.textContent = text;
    },
    onResize: (element, layout) => {
      resizers.set(element, layout);
      observer.observe(element);
    },
  };

  live.setAttribute("aria-live", "polite");

  if (data.theme) applyTheme(data.theme);
  root.dataset["reducedMotion"] = String(data.reducedMotion);
  document.body.append(main, live);

  try {
    main.append(ctx.render(data.spec.root));
  } catch {
    main.replaceChildren(el("p", "v-text", "Couldn't open this visual."));
    send({ type: "render_error", message: "The visual couldn't be rendered." });
  }

  const reportHeight = heightReporter(main, send);
  let stateTimer: number | undefined;
  new ResizeObserver(reportHeight).observe(main);
  window.addEventListener("resize", () => fitScroll(main));
  store.onChange(() => {
    window.clearTimeout(stateTimer);
    stateTimer = window.setTimeout(() => send({ type: "local_state", state: store.snapshot() }), 250);
  });

  if (data.mode !== "frame") return;

  const onConnect = (event: MessageEvent) => {
    if (event.source !== window.parent || !event.ports[0] || !isConnectMessage(event.data, data.instance, data.nonce))
      return;
    window.removeEventListener("message", onConnect);
    port = event.ports[0];
    port.onmessage = (message) => {
      const parsed = parseHostMessage(message.data);

      switch (parsed?.type) {
        case "theme":
          return applyTheme(parsed.theme);
        case "visibility":
          root.dataset["paused"] = String(!parsed.visible);

          return;
        case "reduced_motion":
          root.dataset["reducedMotion"] = String(parsed.reduced);

          return;
        case "reset":
          store.reset();

          return;
      }
    };

    send({ type: "ready", height: naturalHeight(main) });
    reportHeight();
    reportHover();
  };

  const reportHover = hoverReporter(send);

  window.addEventListener("message", onConnect);
  // Keys don't cross the sandbox: Escape alone is forwarded, so a host dialog can close.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) send({ type: "escape" });
  });
}

boot();
