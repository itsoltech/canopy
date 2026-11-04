import { getContext, setContext, type Snippet } from "svelte";

const KEY = Symbol("item-children");

export const provideItemChildren = (children: () => Snippet | undefined): void => {
  setContext(KEY, children);
};

export const useItemChildren = (): (() => Snippet | undefined) =>
  getContext<(() => Snippet | undefined) | undefined>(KEY) ?? (() => undefined);
