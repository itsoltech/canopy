import { getContext, setContext } from "svelte";
import type { ui } from "@open-agents/contracts";

/** Lets timeline items name and link other threads of the project (agent bus targets, parents). */
export interface ThreadDirectory {
  /** The thread being shown. */
  readonly currentId: string;
  thread(id: string): ui.Thread | undefined;
  /** A pending interaction (approval, question) is about this item. */
  awaiting(itemId: string): boolean;
  /** The thread's goal with this id, when it is the one the page knows (its open or last goal). */
  goal(id: string): ui.Goal | undefined;
}

const KEY = Symbol("thread-directory");
export const provideThreadDirectory = (directory: ThreadDirectory) => setContext(KEY, directory);
export const useThreadDirectory = (): ThreadDirectory => getContext<ThreadDirectory | undefined>(KEY) ?? { currentId: "", thread: () => undefined, awaiting: () => false, goal: () => undefined };

/** Each timeline item tells the frames inside it whether it waits for a person. */
const ITEM_KEY = Symbol("item-awaiting");
export const provideItemAwaiting = (awaiting: () => boolean) => setContext(ITEM_KEY, awaiting);
export const useItemAwaiting = (): (() => boolean) => getContext<(() => boolean) | undefined>(ITEM_KEY) ?? (() => false);
