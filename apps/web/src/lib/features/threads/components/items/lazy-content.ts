import { getContext, setContext } from "svelte";
import type { Item, ui } from "@canopy/contracts";
import { SvelteMap } from "svelte/reactivity";

export interface LazyContent {
  reference: ui.ThreadSyncContent;
  threadId: string;
  onload: (item: Item) => void;
}

const KEY = Symbol("lazy-item-content");

/** Completed reads live for the tab's owner session, apart from the timeline reducer. */
export const itemContents = new SvelteMap<string, Item>();

export const provideLazyContent = (content: () => LazyContent | undefined): void => {
  setContext(KEY, content);
};

export const useLazyContent = (): (() => LazyContent | undefined) =>
  getContext<(() => LazyContent | undefined) | undefined>(KEY) ?? (() => undefined);
