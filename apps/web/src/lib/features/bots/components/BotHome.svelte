<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import MachineBadge from "#lib/features/computers/MachineBadge.svelte";
  import ComputerAwayBar from "#lib/features/computers/ComputerAwayBar.svelte";
  import { useBotHome } from "../home.svelte.ts";

  let {
    nodeId = "",
    banner = false,
    class: className,
  }: { nodeId?: string; banner?: boolean; class?: ClassValue } = $props();

  const home = useBotHome(() => nodeId);
</script>

{#if nodeId}
  <div class={["flex min-w-0 flex-wrap items-center gap-2", className]}>
    {#if banner && home.reason}
      <ComputerAwayBar computer={home.computer} reason={home.reason} class="w-full" />
    {:else}
      <MachineBadge {nodeId} />
      {#if banner}
        <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
          Runs on {home.name}. Routines and reminders stay there.
        </p>
      {/if}
    {/if}
  </div>
{/if}
