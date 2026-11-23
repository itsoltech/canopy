import { getContext, setContext } from "svelte";

const key = Symbol("clipboard");

type CopyText = (text: string) => Promise<void>;

export const provideClipboard = (copy: CopyText) => setContext(key, copy);

export const useClipboard = (): CopyText =>
  getContext<CopyText | undefined>(key) ?? ((text) => navigator.clipboard.writeText(text));
