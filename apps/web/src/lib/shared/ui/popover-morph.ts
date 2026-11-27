import { prefersReducedMotion } from "svelte/motion";
import { duration, rootToken } from "./motion.ts";

/**
 * Dropdown menu morph (05, morph variant) for anchored popovers: the trigger turns into the panel. The panel's
 * `::before` (motion.css: `position: fixed`, so the panel's overflow does not clip it, and no DOM child, so the
 * content's `:last-child` or `space-y` rules do not see it) carries the panel's background, ring, shadow and
 * corners and travels from the trigger's box to the
 * panel's box on --ease-spring over --duration-medium, while the panel paints no surface of its own; the
 * content fades in from a light blur once the surface covers it. At the end the panel takes its surface
 * back: both look the same, so the hand-over does not show. Closing runs the surface from the panel back
 * into the trigger on --ease-smooth-out over the exit (--duration-fast), the content fading out first.
 * Every change is a Web Animation, so finishing or cancelling one leaves the panel as it was. Skipped with
 * reduced motion: the panel only fades (motion.css).
 *
 *   const morph = popoverMorph();
 *   morph.open(panel, trigger);   // once the panel is shown and positioned
 *   morph.close(panel, trigger, exitMs);
 */

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/** The look the surface copies from the panel. */
interface Paint {
  readonly backgroundColor: string;
  readonly boxShadow: string;
}

/** Share of the morph after which the content starts to fade in: the surface covers the panel by then. */
const CONTENT_START = 0.5;

/** Share of the close after which the surface fades into the trigger. */
const CLOSE_FADE = 0.6;

function corner(element: Element, rect: DOMRect): number {
  const value = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius);

  return Math.min(Number.isFinite(value) ? value : 0, rect.width / 2, rect.height / 2);
}

function box(element: Element): Box {
  const rect = element.getBoundingClientRect();

  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, radius: corner(element, rect) };
}

function frame({ left, top, width, height, radius }: Box): Keyframe {
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    borderRadius: `${radius}px`,
  };
}

function paint(panel: HTMLElement): Paint {
  const style = getComputedStyle(panel);

  return { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow };
}

function easing(token: "spring" | "smooth-out"): string {
  return rootToken(`--ease-${token}`).trim() || "ease-out";
}

/** The surface: the panel's `::before`. */
const SURFACE = { pseudoElement: "::before" } as const;

/** Without a trigger to morph from, the panel still fades (it keeps full opacity in motion.css). */
function fade(panel: HTMLElement, show: boolean, ms: number): Animation {
  return panel.animate([{ opacity: show ? 0 : 1 }, { opacity: show ? 1 : 0 }], {
    duration: ms,
    easing: easing("smooth-out"),
    fill: show ? "none" : "forwards",
  });
}

/** One morph per popover: a new open or close replaces the one still running. */
export function popoverMorph() {
  let running: Animation[] = [];

  const stop = () => {
    for (const animation of running) animation.cancel();
    running = [];
  };

  /** The panel paints no surface while the morph surface stands in for it. */
  const lend = (panel: HTMLElement, ms: number, fill: FillMode) => {
    const bare = { backgroundColor: "transparent", boxShadow: "none" };
    running.push(panel.animate([bare, bare], { duration: ms, fill }));
  };

  return {
    open(panel: HTMLElement, trigger: Element | undefined) {
      stop();

      if (prefersReducedMotion.current) return;
      const ms = duration("medium");

      if (!trigger?.isConnected) {
        running.push(fade(panel, true, duration("fast")));

        return;
      }

      const look = paint(panel);
      const from = box(trigger);
      const to = box(panel);
      running.push(
        panel.animate(
          [
            { ...frame(from), ...look },
            { ...frame(to), ...look },
          ],
          { ...SURFACE, duration: ms, easing: easing("spring") },
        ),
        panel.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1 }], { ...SURFACE, duration: ms }),
      );
      lend(panel, ms, "none");
      const blur = rootToken("--blur-small").trim() || "2px";

      for (const child of panel.children) {
        running.push(
          child.animate(
            [
              { opacity: 0, filter: `blur(${blur})` },
              { opacity: 1, filter: "blur(0)" },
            ],
            {
              duration: ms * (1 - CONTENT_START),
              delay: ms * CONTENT_START,
              easing: easing("smooth-out"),
              fill: "backwards",
            },
          ),
        );
      }
    },

    close(panel: HTMLElement, trigger: Element | undefined, exitMs: number) {
      stop();

      if (prefersReducedMotion.current || exitMs <= 0) return;

      if (!trigger?.isConnected) {
        running.push(fade(panel, false, exitMs));

        return;
      }

      const look = paint(panel);
      const from = box(panel);
      const to = box(trigger);
      running.push(
        panel.animate(
          [
            { ...frame(from), ...look },
            { ...frame(to), ...look },
          ],
          {
            ...SURFACE,
            duration: exitMs,
            easing: easing("smooth-out"),
            fill: "forwards",
          },
        ),
        panel.animate([{ opacity: 1 }, { opacity: 1, offset: CLOSE_FADE }, { opacity: 0 }], {
          ...SURFACE,
          duration: exitMs,
          fill: "forwards",
        }),
      );
      lend(panel, exitMs, "forwards");

      for (const child of panel.children) {
        running.push(
          child.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: exitMs * (1 - CLOSE_FADE),
            easing: easing("smooth-out"),
            fill: "forwards",
          }),
        );
      }
    },

    cancel: stop,
  };
}
