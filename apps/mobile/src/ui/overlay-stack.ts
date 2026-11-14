import { createContext, type ComponentType } from "react";

/** The app window; overlays rendered outside any overlay present from it. */
export const ROOT_OVERLAY = "root";

/** The overlay whose native modal contains the current subtree. */
export const OverlayParent = createContext(ROOT_OVERLAY);

/** Rendered inside every overlay and once at the root, so shared dialogs can present above the topmost overlay. */
export const OverlayLayer = createContext<ComponentType<{ host: string }> | undefined>(undefined);

interface Entry {
  readonly id: string;
  readonly parent: string;
  /** `waiting` wants to present; `shown` is on screen; `closing` stays until its native modal is gone. */
  readonly phase: "waiting" | "shown" | "closing";
  /** Shared dialogs may present inside it. */
  readonly host: boolean;
}

let entries: readonly Entry[] = [];
const listeners = new Set<() => void>();

export function subscribeOverlays(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function setOverlay(id: string, entry: Omit<Entry, "id"> | undefined) {
  const index = entries.findIndex((item) => item.id === id);
  const previous = entries[index];

  if (!entry) {
    if (!previous) return;
    entries = entries.filter((item) => item.id !== id);
  } else if (!previous) entries = [...entries, { id, ...entry }];
  else if (previous.phase === entry.phase && previous.parent === entry.parent && previous.host === entry.host) return;
  else entries = entries.map((item) => (item.id === id ? { id, ...entry } : item));

  for (const listener of listeners) listener();
}

/**
 * UIKit presents one modal per view controller and refuses a second one, or one during a dismissal, while the
 * refused modal still counts as presented in React Native. Siblings therefore take turns: the first waiting
 * overlay of a parent presents once no sibling is on screen or still dismissing, and only while its parent is open.
 */
export function mayPresent(id: string) {
  const entry = entries.find((item) => item.id === id);

  if (!entry) return false;

  if (entry.phase !== "waiting") return true;

  if (entry.parent !== ROOT_OVERLAY && !overlayShown(entry.parent)) return false;
  const siblings = entries.filter((item) => item.parent === entry.parent);

  return siblings.every((item) => item.phase === "waiting") && siblings[0]?.id === id;
}

/** Overlays presented from this one are still on screen or dismissing. */
export function overlayNested(id: string) {
  return entries.some((item) => item.parent === id && item.phase !== "waiting");
}

/** The topmost shown overlay that hosts shared dialogs, or the root when no overlay is presented. */
export function layerHost() {
  return entries.findLast((item) => item.host && item.phase === "shown")?.id ?? ROOT_OVERLAY;
}

export function overlayShown(id: string) {
  return id === ROOT_OVERLAY || entries.some((item) => item.id === id && item.phase === "shown");
}

/** A shared dialog itself is on screen. */
export function layerShown() {
  return entries.some((item) => !item.host && item.phase === "shown");
}
