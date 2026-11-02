import { getContext, setContext } from "svelte";

const KEY = Symbol("background-output");
/** Timeline items open the same live output dialog as the panel and composer chip. */
export const provideBackgroundOutput = (open: (itemId: string) => void) => setContext(KEY, open);
export const useBackgroundOutput = (): ((itemId: string) => void) | undefined => getContext(KEY);
