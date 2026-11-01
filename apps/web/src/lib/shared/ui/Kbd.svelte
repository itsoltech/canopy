<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { hotkeyKeys, isApple } from "./hotkeys.ts";

  /**
   * Keyboard shortcut hint: `<Kbd hotkey="Mod+1" />` renders ⌘1 on a Mac and Ctrl+1 elsewhere.
   * Hidden on touch-only screens (no keyboard to press it with). Decorative for screen readers when
   * the shortcut is also announced elsewhere (`aria-keyshortcuts` on the control).
   */
  let { hotkey, class: className }: { hotkey: string; class?: ClassValue } = $props();
  // Rendered on the server too: the platform is known only in the browser, so the label settles there.
  let mounted = $state(false);
  $effect(() => {
    mounted = true;
  });
  const apple = $derived(mounted && isApple());
  const keys = $derived(mounted ? hotkeyKeys(hotkey) : []);
</script>

<kbd
  class={["inline-flex shrink-0 items-center gap-0.5 font-sans text-[0.6875rem]/4 text-zinc-400 pointer-coarse:hidden dark:text-zinc-500", className]}
>
  {#each keys as key, index (index)}
    {#if !apple && index > 0}<span aria-hidden="true">+</span>{/if}
    <span class="min-w-4 rounded-sm bg-zinc-950/5 px-1 text-center dark:bg-white/8">{key}</span>
  {/each}
</kbd>
