import { prefersReducedMotion } from "svelte/motion";
import { duration, expand } from "#lib/shared/ui/motion.ts";

/** Short accordion exits for the panel and its rows; CSS t-rise also enters a newly mounted stack.
 * Keep reduced motion instant without changing other consumers of the shared expand recipe. */
export function subagentPresence(node: HTMLElement) {
  return { ...expand(node), duration: prefersReducedMotion.current ? 0 : duration("quick") };
}
