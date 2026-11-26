<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { hotkeyKeys, isApple } from "#lib/shared/ui/hotkeys.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  /**
   * One shortcut of a command as a compact key chip: the keys edit it, the trailing × removes it. Unlike `Kbd` it
   * stays visible on touch screens, where a connected keyboard can still use it.
   */
  let { hotkey, title, onedit, onremove }: { hotkey: string; title: string; onedit: () => void; onremove: () => void } =
    $props();

  // The platform is known only in the browser, so the keys settle after mount.
  let mounted = $state(false);

  $effect(() => {
    mounted = true;
  });

  const apple = $derived(mounted && isApple());
  const keys = $derived(mounted ? hotkeyKeys(hotkey) : []);
  const part = "relative flex h-full items-center focus-ring transition-colors duration-quick";
</script>

<span
  class="inline-flex h-7 shrink-0 items-stretch rounded-md bg-zinc-950/4 text-zinc-700 ring-1 ring-zinc-950/6 ring-inset dark:bg-white/6 dark:text-zinc-300 dark:ring-white/8 pointer-coarse:h-9"
>
  <button
    type="button"
    class={[part, "gap-0.5 rounded-l-md pr-1 pl-1.5 hover:bg-zinc-950/5 dark:hover:bg-white/8"]}
    aria-label={`Edit ${title}: ${hotkey}`}
    {@attach tooltip("Change shortcut")}
    onclick={onedit}
  >
    <kbd class="flex items-center gap-0.5 font-sans text-[0.6875rem]/4 font-medium">
      {#each keys as key, index (index)}
        {#if !apple && index > 0}<span class="text-zinc-400 dark:text-zinc-500" aria-hidden="true">+</span>{/if}
        <span
          class="min-w-4.5 rounded-sm bg-white px-1 text-center shadow-[0_1px_0] shadow-zinc-950/10 dark:bg-white/10 dark:shadow-black/40"
          >{key}</span
        >
      {/each}
    </kbd>
    <TouchTarget size="sm" />
  </button>
  <button
    type="button"
    class={[
      part,
      "rounded-r-md px-1 text-icon-muted hover:bg-zinc-950/5 hover:text-icon-emphasis dark:hover:bg-white/8",
    ]}
    aria-label={`Remove ${title}: ${hotkey}`}
    {@attach tooltip("Remove shortcut")}
    onclick={onremove}
  >
    <Icon name="x-mark" size="xs" tone="inherit" />
    <TouchTarget size="sm" />
  </button>
</span>
