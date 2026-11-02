import { getContext, setContext } from "svelte";
import type { SidebarLayout } from "./sidebar-layout.svelte.ts";

/** Lets pages open the mobile navigation and toggle the desktop sidebar from their own top bar. */
export interface Shell {
  openMenu(): void;
  readonly sidebar?: SidebarLayout | undefined;
}

const KEY = Symbol("shell");
export const provideShell = (shell: Shell) => setContext(KEY, shell);
export const useShell = (): Shell => getContext<Shell | undefined>(KEY) ?? { openMenu: () => {} };
