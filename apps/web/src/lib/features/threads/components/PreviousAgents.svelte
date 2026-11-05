<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";
  import { formatCount } from "#lib/shared/format.ts";
  import { subagentState } from "../subagents/subagents.ts";

  let {
    threads,
    row,
    label = "Previous agents",
    showFailures = false,
    compact = false,
    class: className,
  }: {
    threads: readonly ui.Thread[];
    row: Snippet<[ui.Thread]>;
    label?: string;
    showFailures?: boolean;
    compact?: boolean;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
  const id = $props.id();
  const failures = $derived(showFailures ? threads.filter((thread) => subagentState(thread) === "failed").length : 0);
</script>

{#if threads.length > 0}
  <div class={className}>
    <button
      type="button"
      aria-expanded={open}
      aria-controls={id}
      onclick={() => (open = !open)}
      class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm/5 text-zinc-500 focus-ring hover:bg-zinc-950/4 sm:text-xs/5 dark:text-zinc-400 dark:hover:bg-white/4"
    >
      <Icon name="cpu-chip" class="fill-zinc-400 dark:fill-zinc-500" />
      <span class="min-w-0 flex-1 text-left"
        >{label} ·
        <span class="tabular-nums"
          >{formatCount(threads.length)}{failures ? ` · ${formatCount(failures)} failed` : ""}</span
        ></span
      >
      <Icon name="chevron-right" class={["t-acc-chevron fill-zinc-400 dark:fill-zinc-500", open && "rotate-90"]} />
    </button>
    {#if open}
      <ul
        {id}
        role="list"
        class={["grid min-w-0 grid-cols-1 gap-0.5", compact && "max-h-64 overflow-y-auto overscroll-contain"]}
        transition:expand={{ instantReduced: true }}
      >
        {#each threads as thread (thread.id)}<li>{@render row(thread)}</li>{/each}
      </ul>
    {/if}
  </div>
{/if}
