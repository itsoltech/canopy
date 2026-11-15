import { getContext, setContext } from "svelte";

/** Whether ` ```mermaid ` fences draw as diagrams (a read file) or stay code (chat, still streaming). */
const key = Symbol("markdown-diagrams");
export const provideDiagrams = (scope: { readonly enabled: boolean }) => setContext(key, scope);
export const useDiagrams = () => getContext<{ readonly enabled: boolean } | undefined>(key);
