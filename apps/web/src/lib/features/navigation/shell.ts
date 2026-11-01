import { getContext, setContext } from "svelte";

/** Lets pages open the mobile navigation from their own top bar. */
export interface Shell {
  openMenu(): void;
}

const KEY = Symbol("shell");
export const provideShell = (shell: Shell) => setContext(KEY, shell);
export const useShell = (): Shell => getContext<Shell | undefined>(KEY) ?? { openMenu: () => {} };
