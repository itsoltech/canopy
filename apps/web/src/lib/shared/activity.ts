import type { Attachment } from "svelte/attachments";

interface Activity {
  visible: boolean;
  update: (active: boolean) => void;
}

const activities = new Map<Element, Activity>();
let observer: IntersectionObserver | undefined;

function visibilityChanged() {
  for (const activity of activities.values()) activity.update(activity.visible && !document.hidden);
}

/** One observer for running decorations and clocks; clipped/overscan rows and hidden tabs do no work. */
export function observeActivity(element: Element, update: (active: boolean) => void): () => void {
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const activity = activities.get(entry.target);

        if (!activity) continue;
        activity.visible = entry.isIntersecting;
        activity.update(activity.visible && !document.hidden);
      }
    });
    document.addEventListener("visibilitychange", visibilityChanged);
  }

  activities.set(element, { visible: false, update });
  update(false);
  observer.observe(element);

  return () => {
    observer?.unobserve(element);
    activities.delete(element);

    if (activities.size) return;
    observer?.disconnect();
    observer = undefined;
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
}

/** Pause CSS loops, including their decorative children, without a per-frame JS callback. */
export const runningAnimation: Attachment<Element> = (element) => {
  const stop = observeActivity(element, (active) => {
    element.setAttribute("data-motion-paused", String(!active));
  });

  return () => {
    stop();
    element.removeAttribute("data-motion-paused");
  };
};
