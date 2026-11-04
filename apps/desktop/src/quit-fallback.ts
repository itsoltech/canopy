import type { QuitGuardState } from "@canopy/ui/desktop";

/** Owned by the bundled isolated preload, including with an older remote web build. */
export function quitFallback(delivered: (phase: QuitGuardState["phase"]) => void) {
  let host: HTMLDivElement | undefined;
  let pill: HTMLDivElement;
  let ring: HTMLSpanElement;
  let message: HTMLSpanElement;
  let animation: Animation | undefined;
  let current: QuitGuardState | undefined;

  function render() {
    if (!document.documentElement || !current) return;

    if (!host) {
      host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "closed" });
      // Constructed stylesheets work under the remote page's strict style CSP.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`
        :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: flex; align-items: center; justify-content: center; padding: 24px; }
        .pill { display: flex; align-items: center; gap: 16px; max-width: 100%; padding: 16px 20px; border: 1px solid #ddd; border-radius: 16px; background: white; color: #18181b; box-shadow: 0 12px 30px #0003; font: 500 14px/1.5 system-ui, sans-serif; }
        .ring { display: block; flex-shrink: 0; width: 36px; height: 36px; border: 3px solid #ddd; border-top-color: #6d28d9; border-radius: 50%; }
        .ring[hidden] { display: none; }
        @media (prefers-color-scheme: dark) { .pill { background: #18181b; color: white; border-color: #3f3f46; } }
        @media (prefers-reduced-motion: reduce) { .ring { display: none; } }
      `);
      shadow.adoptedStyleSheets = [sheet];
      pill = document.createElement("div");
      pill.className = "pill";
      pill.setAttribute("role", "status");
      pill.setAttribute("aria-live", "polite");
      ring = document.createElement("span");
      ring.className = "ring";
      ring.setAttribute("aria-hidden", "true");
      message = document.createElement("span");
      pill.append(ring, message);
      shadow.append(pill);
    }

    animation?.cancel();

    if (current.phase === "cancel") {
      host.remove();

      return;
    }

    ring.hidden = current.phase !== "holding";
    message.textContent =
      current.phase === "holding"
        ? `Keep holding ${current.shortcut}… Release to cancel`
        : (current.message ?? `Press ${current.shortcut} twice to quit`);

    if (current.phase === "holding" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      animation = ring.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
        duration: current.durationMs,
        iterations: Infinity,
      });
    }

    document.documentElement.append(host);
    delivered(current.phase);
  }

  document.addEventListener("DOMContentLoaded", render, { once: true });

  return (state: QuitGuardState) => {
    current = state;
    render();
  };
}
