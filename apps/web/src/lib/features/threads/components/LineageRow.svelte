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

  let {
    thread,
    currentId,
    previous = false,
    class: className,
  }: { thread: ui.Thread; currentId: string; previous?: boolean; class?: ClassValue } = $props();

  const provider = $derived(providerKeyOf(thread.provider));
  const icon = $derived(thread.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right");
  const when = $derived(thread.archivedAt ?? thread.lastActivityAt ?? thread.createdAt);
</script>

<PanelRow {icon} href="/threads/{thread.id}" current={thread.id === currentId} class={className}>
  {#snippet lead()}
    {#if (thread.spawnedByAgent || previous) && provider}<ProviderIcon {provider} class="shrink-0" />{:else}<Icon
        name={previous ? "cpu-chip" : icon}
      />{/if}
  {/snippet}
  {thread.title}
  {#if thread.spawnedByAgent}<span class="sr-only"> (started by an agent)</span>{/if}
  {#if thread.forkSourceThreadId}<span class="sr-only"> (fork)</span>{/if}
  {#snippet aside()}
    {#if previous}
      {#if when}<time datetime={isoDateTime(when)} title={formatDateTime(when)} class="shrink-0 tabular-nums"
          >{formatRelative(when, clock.now)}</time
        >{/if}
    {:else}<ThreadStatusText {thread} />{/if}
  {/snippet}
</PanelRow>
