import { flip } from "svelte/animate";
import { cubicInOut, quintOut } from "svelte/easing";
import { prefersReducedMotion } from "svelte/motion";
import type { AnimationConfig } from "svelte/animate";
import type { Attachment } from "svelte/attachments";
import type { TransitionConfig } from "svelte/transition";

/**
 * Motion in script, on the same token scale as the CSS (routes/layout.css): token values are read from
 * the document, so a change of the scale reaches both. `smoothOut` and `inOut` are the JS twins of
 * `--ease-smooth-out` (cubic-bezier(0.22, 1, 0.36, 1) = easeOutQuint) and `--ease-in-out`.
 * With reduced motion every transition here is opacity only.
 *
 *   {#if open}<div transition:expand>…</div>{/if}
 */
export const smoothOut = quintOut;
export const inOut = cubicInOut;

export type DurationToken = "stagger" | "micro" | "quick" | "fast" | "medium" | "slow" | "very-slow";

const fallback: Record<DurationToken, number> = { stagger: 40, micro: 80, quick: 150, fast: 250, medium: 350, slow: 400, "very-slow": 500 };

/** A duration token in ms (`duration("fast")` = `--duration-fast`). */
export function duration(token: DurationToken): number {
  if (typeof document === "undefined") return fallback[token];
  const value = toMs(getComputedStyle(document.documentElement).getPropertyValue(`--duration-${token}`));
  return Number.isFinite(value) ? value : fallback[token];
}

/** A CSS time in ms: "250ms", ".25s" (the minifier rewrites the tokens to seconds). */
export function toMs(time: string): number {
  const value = Number.parseFloat(time);
  return time.trim().endsWith("ms") ? value : value * 1000;
}

/** A length token in px (`distance("base")` = `--distance-base`, 0 with reduced motion). */
function length(name: string, fallbackPx: number): number {
  if (typeof document === "undefined") return fallbackPx;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallbackPx;
}

/**
 * Accordion expand / collapse (21) for content mounted with its disclosure: height from and to 0 with a
 * fade and cross-blur, on --duration-fast both ways (one reversible motion).
 */
export function expand(node: HTMLElement, { delay = 0, instantReduced = false }: { delay?: number; instantReduced?: boolean } = {}): TransitionConfig {
  const ms = duration("fast");
  if (prefersReducedMotion.current) return { delay: instantReduced ? 0 : delay, duration: instantReduced ? 0 : ms, css: (t) => `opacity: ${t}` };
  const style = getComputedStyle(node);
  const height = node.offsetHeight;
  const blur = length("--blur-small", 2);
  const padTop = Number.parseFloat(style.paddingTop);
  const padBottom = Number.parseFloat(style.paddingBottom);
  const marginTop = Number.parseFloat(style.marginTop);
  const marginBottom = Number.parseFloat(style.marginBottom);
  return {
    delay,
    duration: ms,
    easing: smoothOut,
    css: (t) =>
      `overflow: hidden; height: ${t * height}px; padding-top: ${t * padTop}px; padding-bottom: ${t * padBottom}px; ` +
      `margin-top: ${t * marginTop}px; margin-bottom: ${t * marginBottom}px; opacity: ${t}; filter: blur(${(1 - t) * blur}px)`,
  };
}

/**
 * Rise (toast 22 / texts reveal 18 for one element): fade and cross-blur up from --distance-base, for
 * things that appear on their own (a button over the timeline, a new list row). In on --duration-fast,
 * out on --duration-quick.
 */
export function rise(node: HTMLElement, { delay = 0 }: { delay?: number } = {}, options?: { direction: "in" | "out" | "both" }): TransitionConfig {
  const out = options?.direction === "out";
  const ms = duration(out ? "quick" : "fast");
  if (prefersReducedMotion.current) return { delay, duration: ms, css: (t) => `opacity: ${t}` };
  const distance = length("--distance-base", 8);
  const blur = length("--blur-small", 2);
  return {
    delay,
    duration: ms,
    easing: smoothOut,
    css: (t, u) => `opacity: ${t}; translate: 0 ${u * distance}px; filter: blur(${u * blur}px)`,
  };
}

/**
 * Text states swap (04), entering half: a label that changed (a status) rises in from --distance-micro
 * with a blur, on --duration-quick. Use it as `in:` inside a `{#key}` of the value: the first render
 * and remounted rows show it at once.
 */
export function swap(_node: HTMLElement, { delay = 0 }: { delay?: number } = {}): TransitionConfig {
  const ms = duration("quick");
  if (prefersReducedMotion.current) return { delay, duration: 0 };
  const distance = length("--distance-micro", 4);
  const blur = length("--blur-small", 2);
  return {
    delay,
    duration: ms,
    easing: inOut,
    css: (t, u) => `opacity: ${t}; translate: 0 ${u * distance}px; filter: blur(${u * blur}px)`,
  };
}

/**
 * Text states swap (04) for a value on a scale, both halves at once: the old text leaves and the new one
 * arrives along the scale's direction (`step` 1 = up the scale: the new text rises in from below, the old
 * one rises out; -1 the other way), with a fade and cross-blur on --duration-quick. Use the same call as
 * `in:` and `out:` on the text inside a `{#key}`, both stacked in one grid cell (SwapText.svelte), so
 * the swap never shifts the layout. With reduced motion it is a cross-fade.
 */
export function stepSwap(
  _node: HTMLElement,
  { step = 1, distance = "micro" }: { step?: number; distance?: "micro" | "base" } = {},
  options?: { direction: "in" | "out" | "both" },
): TransitionConfig {
  const ms = duration("quick");
  if (prefersReducedMotion.current) return { duration: ms, css: (t) => `opacity: ${t}` };
  const offset = length(`--distance-${distance}`, distance === "base" ? 8 : 4) * (options?.direction === "out" ? -step : step);
  const blur = length("--blur-small", 2);
  return {
    duration: ms,
    easing: inOut,
    css: (t, u) => `opacity: ${t}; translate: 0 ${u * offset}px; filter: blur(${u * blur}px)`,
  };
}

/**
 * Page side-by-side (08): wizard steps and list ↔ detail. The page that comes later in the order (`step` 1, a next
 * step, the detail) enters from --distance-base on the right and the earlier one leaves to the left; `step` -1 the
 * other way. Fade and --blur-medium cross-blur on --duration-fast with --ease-smooth-out. Use the same call as `in:`
 * and `out:` inside a `{#key}` of the page, both pages stacked in one grid cell so the swap never shifts the layout.
 * With reduced motion it is a cross-fade.
 */
export function pageSlide(_node: HTMLElement, { step = 1 }: { step?: number } = {}, options?: { direction: "in" | "out" | "both" }): TransitionConfig {
  const ms = duration("fast");
  if (prefersReducedMotion.current) return { duration: ms, css: (t) => `opacity: ${t}` };
  const offset = length("--distance-base", 8) * (options?.direction === "out" ? -step : step);
  const blur = length("--blur-medium", 3);
  return {
    duration: ms,
    easing: smoothOut,
    css: (t, u) => `opacity: ${t}; translate: ${u * offset}px 0; filter: blur(${u * blur}px)`,
  };
}

/**
 * Page side-by-side (08), entering half: a level of a list that replaced the previous one in place (a
 * submenu opened or left) slides in from --distance-base on the side it comes from (`from` 1 = deeper,
 * from the right; -1 = back, from the left) with a fade and cross-blur on --duration-fast. The old level
 * goes at once, so the two never overlap. With reduced motion it only fades.
 */
export function pageIn(_node: HTMLElement, { from = 1 }: { from?: number } = {}): TransitionConfig {
  const ms = duration("fast");
  if (prefersReducedMotion.current) return { duration: ms, css: (t) => `opacity: ${t}` };
  const distance = length("--distance-base", 8) * from;
  const blur = length("--blur-medium", 3);
  return { duration: ms, easing: smoothOut, css: (t, u) => `opacity: ${t}; translate: ${u * distance}px 0; filter: blur(${u * blur}px)` };
}

/** Icon swap (09), entering half: a status icon that changed grows in from a quarter with a blur. */
export function iconSwap(_node: HTMLElement, { delay = 0 }: { delay?: number } = {}): TransitionConfig {
  const ms = duration("fast");
  if (prefersReducedMotion.current) return { delay, duration: 0 };
  const blur = length("--blur-small", 2);
  return {
    delay,
    duration: ms,
    easing: inOut,
    css: (t, u) => `opacity: ${t}; scale: ${0.25 + 0.75 * t}; filter: blur(${u * blur}px)`,
  };
}

/**
 * Pop (menu dropdown 05 on a single item): something the user just added (an attachment chip) grows in from
 * --scale-medium on --duration-fast and leaves on --duration-quick; neighbours glide aside with `reorder`.
 */
export function pop(_node: HTMLElement, { delay = 0 }: { delay?: number } = {}, options?: { direction: "in" | "out" | "both" }): TransitionConfig {
  const out = options?.direction === "out";
  const ms = duration(out ? "quick" : "fast");
  if (prefersReducedMotion.current) return { delay, duration: ms, css: (t) => `opacity: ${t}` };
  const from = length("--scale-medium", 0.97);
  const blur = length("--blur-small", 2);
  return { delay, duration: ms, easing: smoothOut, css: (t, u) => `opacity: ${t}; scale: ${from + (1 - from) * t}; filter: blur(${u * blur}px)` };
}

/** List reorder (`animate:reorder` in a keyed each): rows glide to their new place (position change). */
export function reorder(node: Element, positions: { from: DOMRect; to: DOMRect }): AnimationConfig {
  return flip(node, positions, { duration: prefersReducedMotion.current ? 0 : duration("fast"), easing: smoothOut });
}

/** Delay of the `index`-th item of a group that appears together (--duration-stagger, capped so the last waits under 300 ms). */
export function stagger(index: number, cap = 7): number {
  return Math.min(index, cap) * duration("stagger");
}

/**
 * Error state shake (12): replays the shake (motion.css `t-shake`) whenever the attachment is created
 * with a truthy `trigger`, e.g. `{@attach shake(error)}` on the field that refused its value.
 */
export function shake(trigger: unknown = true): Attachment<HTMLElement> {
  return (node) => {
    if (!trigger) return;
    node.classList.remove("t-shake");
    void node.offsetWidth; // restart the animation
    node.classList.add("t-shake");
    const done = () => node.classList.remove("t-shake");
    node.addEventListener("animationend", done, { once: true });
    return () => node.removeEventListener("animationend", done);
  };
}

/**
 * Card resize (01) for content that changes width (a button that becomes a wider one): the element takes
 * its first child's measured width and eases to each new one (motion.css `t-resize`), so its
 * neighbours glide instead of jumping. The first width is set at once.
 *
 *   <div class="t-resize" {@attach resizeToContent}><div class="w-max">…</div></div>
 */
export const resizeToContent: Attachment<HTMLElement> = (node) => followContent(node, "width");

/**
 * Card resize (01) on the height, for a list whose rows arrive or leave after it is shown (a page that
 * loads, a skeleton replaced by rows): the element takes its first child's height and eases to each new
 * one (motion.css `t-resize-height`, clipped meanwhile), so what follows glides instead of jumping.
 *
 *   <div class="t-resize-height" {@attach resizeHeightToContent}><div>…</div></div>
 */
export const resizeHeightToContent: Attachment<HTMLElement> = (node) => followContent(node, "height");

function followContent(node: HTMLElement, axis: "width" | "height") {
  let first = true;
  const observer = new ResizeObserver(() => {
    const content = node.firstElementChild as HTMLElement | null;
    const size = content ? (axis === "width" ? content.offsetWidth : content.offsetHeight) : 0;
    if (first) {
      node.style.transition = "none";
      node.style[axis] = `${size}px`;
      void node.offsetWidth;
      node.style.transition = "";
      first = false;
    } else node.style[axis] = `${size}px`;
  });
  const watch = () => {
    observer.disconnect();
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    else node.style[axis] = "0px";
  };
  // The child itself can be replaced ({#if} inside): follow it.
  const children = new MutationObserver(watch);
  children.observe(node, { childList: true });
  watch();
  return () => {
    observer.disconnect();
    children.disconnect();
  };
}

/** How long an element's exit transition lasts (its longest `transition-duration` now), in ms. */
export function exitDuration(element: Element): number {
  return Math.max(0, ...getComputedStyle(element).transitionDuration.split(",").map((value) => toMs(value) || 0));
}
