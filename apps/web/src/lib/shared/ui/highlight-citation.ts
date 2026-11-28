import { motionPreferences } from "./motion-preferences.svelte.ts";
import { duration } from "./motion.ts";

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Keep the static highlight readable for the full interval when the fade is disabled. */
export function highlightCitation(element: HTMLElement): void {
  clearTimeout(timers.get(element));
  element.removeAttribute("data-flash");
  void element.offsetWidth;
  element.setAttribute("data-flash", "");
  const ms = motionPreferences.reduced ? 1500 : duration("very-slow") * 3;
  timers.set(
    element,
    setTimeout(() => {
      element.removeAttribute("data-flash");
      timers.delete(element);
    }, ms),
  );
}
