import { prefersReducedMotion } from "svelte/motion";
import { duration, rootToken } from "./motion.ts";

/**
 * Dropdown menu morph (05, morph variant) for anchored popovers opened by a press (`openedByPress`): the
 * trigger turns into the panel. The panel's `::before` (motion.css: `position: fixed`, so the panel's overflow
 * does not clip it, and no DOM child, so the content's `:last-child` or `space-y` rules do not see it) carries
 * the panel's background, ring, shadow and corners and travels from the trigger's box to the panel's box on
 * --ease-spring over --duration-fast, sharpening from a --blur-medium blur, while the panel paints no surface
 * of its own; the content fades in from the same blur as the surface covers it. At the end the panel takes its
 * surface back: both look the same, so the hand-over does not show. Closing runs the surface from the panel
 * back into the trigger on --ease-smooth-out over the exit (--duration-quick), blurring as it shrinks, the
 * content blurring out first. Every change is a Web Animation, so finishing or cancelling one leaves the panel
 * as it was. Skipped with reduced motion: the panel only fades (motion.css).
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

/** Share of the morph after which the content starts to fade in: the surface covers most of the panel by then. */
const CONTENT_START = 0.3;

/** Share of the morph by which the surface has lost its blur. */
const SURFACE_SHARP = 0.8;

/** Share of the close after which the surface fades into the trigger. */
const CLOSE_FADE = 0.5;

/** Press events whose handlers open a popover synchronously or within their microtasks. */
const PRESS_EVENTS = ["pointerdown", "click", "keydown", "contextmenu"] as const;

let pressing = false;
let pressReset: ReturnType<typeof setTimeout> | undefined;
let listening = false;

function onPress() {
  pressing = true;
  clearTimeout(pressReset);
  pressReset = setTimeout(() => (pressing = false));
}

/** Watch presses from the first popover on, so its first opening already knows how it was opened. */
function listenForPresses() {
  if (listening || typeof window === "undefined") return;
  listening = true;

  for (const type of PRESS_EVENTS) window.addEventListener(type, onPress, { capture: true, passive: true });
}

/**
 * Whether the popover opening now follows a press (click, tap, key, context menu) rather than a hover: only a
 * press morphs. Svelte runs the effect that shows the panel in a microtask after the press handler, before the
 * task this resets in; a hover opening (pointerenter, or after an intent delay) finds it unset.
 */
export function openedByPress(): boolean {
  return pressing;
}

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

function easing(token: "spring" | "smooth-out" | "out"): string {
  return rootToken(`--ease-${token}`).trim() || "ease-out";
}

/** The blur the surface and the content start from (open) or end at (close). */
function blurred(): string {
  return `blur(${rootToken("--blur-medium").trim() || "3px"})`;
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
  listenForPresses();
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
      const ms = duration("fast");

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
        panel.animate([{ filter: blurred() }, { filter: "blur(0)" }], {
          ...SURFACE,
          duration: ms * SURFACE_SHARP,
          easing: easing("out"),
        }),
      );
      lend(panel, ms, "none");

      for (const child of panel.children) {
        running.push(
          child.animate(
            [
              { opacity: 0, filter: blurred() },
              { opacity: 1, filter: "blur(0)" },
            ],
            {
              duration: ms * (1 - CONTENT_START),
              delay: ms * CONTENT_START,
              easing: easing("out"),
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
        panel.animate(
          [
            { opacity: 1, filter: "blur(0)" },
            { opacity: 1, offset: CLOSE_FADE },
            { opacity: 0, filter: blurred() },
          ],
          { ...SURFACE, duration: exitMs, fill: "forwards" },
        ),
      );
      lend(panel, exitMs, "forwards");

      for (const child of panel.children) {
        running.push(
          child.animate(
            [
              { opacity: 1, filter: "blur(0)" },
              { opacity: 0, filter: blurred() },
            ],
            {
              duration: exitMs * (1 - CLOSE_FADE),
              easing: easing("smooth-out"),
              fill: "forwards",
            },
          ),
        );
      }
    },

    cancel: stop,
  };
}
