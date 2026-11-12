import { getContext, setContext } from "svelte";

/** Opens a file path an agent wrote (features/files): Markdown turns such paths into selectable links. */
export interface FileLinkHandler {
  open(path: string): void;
}

const KEY = Symbol("file-links");

export const provideFileLinks = <H extends FileLinkHandler>(handler: H): H => setContext(KEY, handler);

/** Undefined outside a thread: paths stay plain code. */
export const useFileLinks = (): FileLinkHandler | undefined => getContext<FileLinkHandler | undefined>(KEY);
