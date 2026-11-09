import { createContext, useContext, type ReactNode } from "react";
import type { Item, ui } from "@canopy/contracts";
import { router } from "expo-router";

/**
 * What the items of one thread's timeline look up (web: thread-directory.ts): the other threads they name, where
 * the bus messages of this thread got to, the items background notes refer to and the open thread's id.
 */
export interface TimelineDirectory {
  readonly currentId: string;
  readonly sourceId?: string;
  readonly quote?: (quote: ui.Quote) => void;
  /** Archived, deleted or inherited history: nothing can be stopped or sent from here. */
  readonly readOnly: boolean;
  readonly thread: (id: string) => ui.Thread | undefined;
  readonly item: (id: string) => Item | undefined;
  readonly delivery: (callId: string) => ui.BusDelivery | undefined;
  readonly queuedFallback?: (turnId: string) => ui.Steer | undefined;
}

const Directory = createContext<TimelineDirectory>({
  currentId: "",
  readOnly: true,
  thread: () => undefined,
  item: () => undefined,
  delivery: () => undefined,
});

export function TimelineDirectoryProvider({ value, children }: { value: TimelineDirectory; children: ReactNode }) {
  return <Directory.Provider value={value}>{children}</Directory.Provider>;
}

export const useTimelineDirectory = () => useContext(Directory);

/** Opens another thread of the timeline (a subagent, the sender of a message). */
export const openThread = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } });
