<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";

  let { threads, row, class: className }: { threads: readonly ui.Thread[]; row: Snippet<[ui.Thread]>; class?: ClassValue } = $props();
  let open = $state(false);
  const id = $props.id();
</script>

{#if threads.length > 0}
  <div class={className}>
    <button type="button" aria-expanded={open} aria-controls={id} onclick={() => (open = !open)} class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm/5 text-zinc-500 hover:bg-zinc-950/4 focus-ring sm:text-xs/5 dark:text-zinc-400 dark:hover:bg-white/4">
      <Icon name="cpu-chip" class="fill-zinc-400 dark:fill-zinc-500" />
      <span class="min-w-0 flex-1 text-left">Previous agents · <span class="tabular-nums">{threads.length}</span></span>
      <Icon name="chevron-right" class={["t-acc-chevron fill-zinc-400 dark:fill-zinc-500", open && "rotate-90"]} />
    </button>
    {#if open}
      <ul {id} role="list" class="grid gap-0.5" transition:expand>
        {#each threads as thread (thread.id)}<li>{@render row(thread)}</li>{/each}
      </ul>
    {/if}
  </div>
{/if}
