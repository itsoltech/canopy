<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { providerKeyOf } from "../providers.ts";
  import ThreadStatusText from "../ThreadStatusText.svelte";
  import PanelRow from "./PanelRow.svelte";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatDateTime, formatRelative, isoDateTime } from "#lib/shared/format.ts";
  import { subagentLook, subagentState } from "../subagents/subagents.ts";

  let {
    thread,
    currentId,
    previous = false,
    finished = false,
    class: className,
  }: { thread: ui.Thread; currentId: string; previous?: boolean; finished?: boolean; class?: ClassValue } = $props();

  const provider = $derived(providerKeyOf(thread.provider));
  const icon = $derived(thread.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right");
  const when = $derived(thread.archivedAt ?? thread.lastActivityAt ?? thread.createdAt);
  const activity = $derived(thread.lastActivityAt ?? thread.createdAt);
</script>

<PanelRow {icon} href="/threads/{thread.id}" current={thread.id === currentId} class={className}>
  {#snippet lead()}
    {#if (thread.spawnedByAgent || previous) && provider}<ProviderIcon {provider} class="shrink-0" />{:else}<Icon
        name={previous ? "cpu-chip" : icon}
      />{/if}
  {/snippet}
  <span title={thread.title}>{thread.title || "Subagent"}</span>
  {#if finished}
    <span class="flex gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <span>{subagentLook(subagentState(thread)).label}</span>
      {#if activity}<time
          datetime={isoDateTime(activity)}
          title={formatDateTime(activity)}
          class="truncate tabular-nums">{formatRelative(activity, clock.now)}</time
        >{/if}
    </span>
  {/if}
  {#if thread.spawnedByAgent}<span class="sr-only"> (started by an agent)</span>{/if}
  {#if thread.forkSourceThreadId}<span class="sr-only"> (fork)</span>{/if}
  {#snippet aside()}
    {#if finished}
      <Icon name="chevron-right" class="shrink-0" />
    {:else if previous}
      {#if when}<time datetime={isoDateTime(when)} title={formatDateTime(when)} class="shrink-0 tabular-nums"
          >{formatRelative(when, clock.now)}</time
        >{/if}
    {:else}<ThreadStatusText {thread} />{/if}
  {/snippet}
</PanelRow>
