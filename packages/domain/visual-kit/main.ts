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

function heightReporter(main: HTMLElement, send: (message: FrameMessage) => void) {
  let last = 0;
  let pending: number | undefined;
  let reported = -1;
  const interval = 1000 / VISUAL_LIMITS.heightsPerSecond;

  const report = () => {
    pending = undefined;
    const style = getComputedStyle(document.body);
    const height = Math.ceil(main.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));

    if (height === reported) return;
    reported = height;
    last = performance.now();
    send({ type: "height", height });
  };

  return () => {
    if (pending !== undefined) return;
    const wait = Math.max(0, interval - (performance.now() - last));
    pending = window.setTimeout(report, wait);
  };
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

    send({ type: "ready", height: Math.ceil(main.offsetHeight) });
    reportHeight();
  };

  window.addEventListener("message", onConnect);
  // Keys don't cross the sandbox: Escape alone is forwarded, so a host dialog can close.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) send({ type: "escape" });
  });
}

boot();
