import { prefersReducedMotion } from "svelte/motion";
import type { TransitionConfig } from "svelte/transition";
import { duration, smoothOut } from "#lib/shared/ui/motion.ts";

/** The column reaches its final width once; only the fixed-width surface fades. */
export function workspacePanel(
  _node: HTMLElement,
  instant: boolean,
  direction: { direction: "in" | "out" | "both" },
): TransitionConfig {
  return {
    duration: instant || prefersReducedMotion.current ? 0 : duration(direction.direction === "out" ? "medium" : "slow"),
    easing: smoothOut,
    css: (t) => `opacity: ${t}`,
  };
}
