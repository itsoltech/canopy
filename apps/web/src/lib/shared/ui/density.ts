import { getContext, setContext } from "svelte";

/**
 * UI context of a subtree (docs/ui-scale.md). Popovers, menus, pickers and the command palette are `overlay`:
 * kit controls without an explicit size take the compact size there, and `scale.css` (`density-overlay`) makes the
 * text steps one smaller. Dialogs return to `standard` for what they contain.
 */
export type Density = "standard" | "overlay";

const KEY = Symbol("density");
export const provideDensity = (density: Density) => setContext(KEY, density);
export const useDensity = (): Density => getContext<Density | undefined>(KEY) ?? "standard";
