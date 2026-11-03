import { getContext, setContext } from "svelte";
import type { Item, ui } from "@canopy/contracts";

/** Lets timeline items name and link other threads of the project (agent bus targets, parents). */
export interface ThreadDirectory {
  /** The thread being shown. */
  readonly currentId: string;
  thread(id: string): ui.Thread | undefined;
  /** A pending interaction (approval, question) is about this item. */
  awaiting(itemId: string): boolean;
  /** The thread's goal with this id, when it is the one the page knows (its open or last goal). */
  goal(id: string): ui.Goal | undefined;
  /** The turn with this id is over (completed, failed, interrupted): its items stop streaming. */
  turnEnded?(turnId: string): boolean;
  /** The thread's steer with this id (a message steered into a turn: its text and quotes). */
  steer?(id: string): ui.Steer | undefined;
  /** The thread's own timeline item with this id (e.g. the background task a platform note is about). */
  item?(id: string): Item | undefined;
  /** Where the thread's spawn_thread / send_message call with this id went: the target turn and its live status. */
  delivery?(callId: string): ui.BusDelivery | undefined;
  /** Its turns can be forked from ("Fork from here"): a thread on a worker that started at its provider. */
  readonly canFork?: boolean;
  /** Scrolls to the item a quote came from and highlights it; false when it is not in this thread any more. */
  revealQuote?(quote: ui.Quote): Promise<boolean>;
}

const KEY = Symbol("thread-directory");
export const provideThreadDirectory = (directory: ThreadDirectory) => setContext(KEY, directory);
export const useThreadDirectory = (): ThreadDirectory => getContext<ThreadDirectory | undefined>(KEY) ?? { currentId: "", thread: () => undefined, awaiting: () => false, goal: () => undefined };

/** Each timeline item tells the frames inside it whether it waits for a person. */
const ITEM_KEY = Symbol("item-awaiting");
export const provideItemAwaiting = (awaiting: () => boolean) => setContext(ITEM_KEY, awaiting);
export const useItemAwaiting = (): (() => boolean) => getContext<(() => boolean) | undefined>(ITEM_KEY) ?? (() => false);
