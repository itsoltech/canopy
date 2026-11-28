import { motionPreferences } from "#lib/shared/ui/motion-preferences.svelte.ts";
import { duration, expand } from "#lib/shared/ui/motion.ts";

/** Short accordion exits for the panel and its rows; CSS t-rise also enters a newly mounted stack.
 * Keep reduced motion instant without changing other consumers of the shared expand recipe. */
export function subagentPresence(node: HTMLElement) {
  return { ...expand(node), duration: motionPreferences.reduced ? 0 : duration("quick") };
}
