import { getContext, setContext, untrack } from "svelte";
import { useCommands, type CommandSource } from "./registry.ts";

/** Opens the palette with Mod+K (⌘K on a Mac, Ctrl+K elsewhere). */
export const PALETTE_HOTKEY = "Mod+K";

/**
 * Adds commands to the palette for as long as the calling component is mounted (browser only). The
 * source is read whenever the palette lists, so it may close over the component's state:
 *
 *   contributeCommands(() => [{ id: "thread:interrupt", title: "Interrupt", group: "actions", when: () => working, run: stop }]);
 */
export function contributeCommands(source: CommandSource): void {
  const registry = useCommands();
  $effect(() => untrack(() => registry?.add(source)));
}

/** Whether the palette is open; `show` opens it from a button (touch screens have no Mod+K). */
export class PaletteState {
  open = $state(false);

  show(): void {
    this.open = true;
  }

  toggle(): void {
    this.open = !this.open;
  }
}

const KEY = Symbol("palette");
export const providePalette = (state: PaletteState) => setContext(KEY, state);
export const usePalette = (): PaletteState | undefined => getContext<PaletteState | undefined>(KEY);
