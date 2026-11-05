<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatCount } from "#lib/shared/format.ts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { subagentLineage } from "../subagents/lineage.ts";
  import LineageRow from "./LineageRow.svelte";
  import PreviousAgents from "./PreviousAgents.svelte";

  let {
    threads,
    currentId,
    class: className,
  }: { threads: readonly ui.Thread[]; currentId: string; class?: ClassValue } = $props();

  const lineage = $derived(subagentLineage(threads, clock.now, device.values.showFinishedSubagents === "on"));
  const expanded = $derived(device.values.subagentsExpanded === "on");

  const label = $derived(
    [
      "Subagents",
      ...(lineage.running ? [`${formatCount(lineage.running)} running`] : []),
      ...(lineage.waiting ? [`${formatCount(lineage.waiting)} ${lineage.waiting === 1 ? "needs" : "need"} input`] : []),
      ...(lineage.finished ? [`${formatCount(lineage.finished)} finished`] : []),
    ].join(" · "),
  );
</script>

{#if lineage.current.length || lineage.previous.length || lineage.finished}
  <div class={className}>
    {#if lineage.current.length || lineage.previous.length}
      <Disclosure
        open={expanded}
        onchange={(open) => device.set("subagentsExpanded", open ? "on" : "off")}
        align="center"
        summaryClass="min-h-10 px-3 py-2 text-sm/5 text-zinc-500 sm:min-h-9 sm:text-xs/5 dark:text-zinc-400 hover:bg-zinc-950/4 dark:hover:bg-white/4"
      >
        {#snippet summary()}<span role="status" class="tabular-nums">{label}</span>{/snippet}
        {#if lineage.current.length}<ul
            role="list"
            aria-label="Active and recent subagents"
            class="grid grid-cols-1 gap-0.5"
          >
            {#each lineage.current as thread (thread.id)}
              <li><LineageRow {thread} {currentId} /></li>
            {/each}
          </ul>{/if}
        <PreviousAgents threads={lineage.previous} label="Previous subagents" showFailures compact>
          {#snippet row(thread)}<LineageRow {thread} {currentId} />{/snippet}
        </PreviousAgents>
      </Disclosure>
    {:else}
      <p role="status" class="px-3 py-2 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">
        {label}
      </p>
    {/if}
  </div>
{/if}
