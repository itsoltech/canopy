<script lang="ts">
  import { threadSortModes } from "@canopy/domain/thread-order";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { ClassValue } from "svelte/elements";

  let { class: className }: { class?: ClassValue } = $props();
</script>

<div class={className} role="group" aria-label="Sort threads">
  <p class="px-2 pt-1 pb-0.5 text-sm font-medium text-zinc-500 sm:text-xs dark:text-zinc-400">Sort threads</p>
  {#each threadSortModes as mode (mode.value)}
    <Button
      variant="ghost"
      class="w-full justify-start"
      aria-pressed={devicePreferences.view.threadSortMode === mode.value}
      onclick={() => devicePreferences.setView({ threadSortMode: mode.value })}
    >
      <span class="min-w-0 flex-1 text-left">{mode.label}</span>
      <span class="grid size-4 shrink-0 place-items-center"
        >{#if devicePreferences.view.threadSortMode === mode.value}<Icon name="check" />{/if}</span
      >
    </Button>
  {/each}
  {#if devicePreferences.view.threadSortMode === "custom"}
    <p class="px-2 py-1 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
      Drag within a section to reorder. Drag to Pinned to pin.
    </p>
    <p class="px-2 pb-1 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
      Use Move in the thread menu, or Alt+↑/↓.
    </p>
  {/if}
</div>
