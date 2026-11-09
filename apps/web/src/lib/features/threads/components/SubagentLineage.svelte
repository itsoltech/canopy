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
  import SubagentList from "./SubagentList.svelte";

  let {
    threads,
    currentId,
    class: className,
  }: { threads: readonly ui.Thread[]; currentId: string; class?: ClassValue } = $props();

  const lineage = $derived(subagentLineage(threads, clock.now, device.values.showFinishedSubagents === "on"));
  const expanded = $derived(device.values.subagentsExpanded === "on");
  const hasMainList = $derived(lineage.current.length > 0 || lineage.previous.length > 0);

  const label = $derived(
    [
      "Subagents",
      ...(lineage.running ? [`${formatCount(lineage.running)} running`] : []),
      ...(lineage.waiting ? [`${formatCount(lineage.waiting)} ${lineage.waiting === 1 ? "needs" : "need"} input`] : []),
      ...(lineage.finished && !lineage.collapsed.length ? [`${formatCount(lineage.finished)} finished`] : []),
    ].join(" · "),
  );
</script>

{#if lineage.current.length || lineage.previous.length || lineage.finished}
  <div class={className}>
    {#if hasMainList}
      <Disclosure
        open={expanded}
        onchange={(open) => device.set("subagentsExpanded", open ? "on" : "off")}
        align="center"
        summaryClass="min-h-9 px-2 py-1 text-sm/5 text-zinc-500 sm:min-h-8 sm:text-xs/5 dark:text-zinc-400 hover:bg-zinc-950/4 dark:hover:bg-white/4"
      >
        {#snippet summary()}<span role="status" class="tabular-nums">{label}</span>{/snippet}
        <SubagentList threads={lineage.current} {currentId} label="Active and recent subagents" />
        <PreviousAgents threads={lineage.previous} label="Previous subagents" showFailures compact>
          {#snippet row(thread)}<LineageRow {thread} {currentId} />{/snippet}
        </PreviousAgents>
      </Disclosure>
    {/if}
    {#if lineage.collapsed.length}
      <Disclosure
        open={device.values.finishedSubagentsExpanded === "on"}
        onchange={(open) => device.set("finishedSubagentsExpanded", open ? "on" : "off")}
        align="center"
        summaryClass="min-h-9 px-2 py-1 text-sm/5 text-zinc-500 sm:min-h-8 sm:text-xs/5 dark:text-zinc-400 hover:bg-zinc-950/4 dark:hover:bg-white/4"
      >
        {#snippet summary()}<span role="status" class="tabular-nums"
            >{hasMainList ? "" : "Subagents · "}{formatCount(lineage.finished)} finished</span
          >{/snippet}
        <SubagentList
          threads={lineage.collapsed}
          {currentId}
          label="Finished subagents"
          finished
          class="max-h-64 overflow-y-auto overscroll-contain"
        />
      </Disclosure>
    {/if}
  </div>
{/if}
