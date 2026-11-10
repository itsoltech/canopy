<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { Tone } from "#lib/shared/ui/tone.ts";
  import type { OverviewConnection } from "#lib/features/overview/overview-state.svelte.ts";

  /**
   * Gateway connection of this tab, announced politely when it changes. `quietWhenLive`: the gateway is part of this
   * app (desktop local mode), so only trouble is worth showing.
   */
  let {
    connection,
    quietWhenLive = false,
    class: className,
  }: { connection: OverviewConnection; quietWhenLive?: boolean; class?: ClassValue } = $props();

  const look = $derived(
    (
      {
        live: { tone: "emerald", label: "Connected" },
        reconnecting: { tone: "amber", label: "Reconnecting…" },
        unavailable: { tone: "rose", label: "Gateway unavailable" },
      } satisfies Record<OverviewConnection, { tone: Tone; label: string }>
    )[connection],
  );
</script>

<!-- The width of the longest label stays reserved (no shift when it changes), on the left: the dot keeps to its word. -->
<!-- The live region stays mounted while quiet, so a later reconnect is still announced. -->
<p class={["flex items-center text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]} role="status">
  {#if !(quietWhenLive && connection === "live")}
    <span class="flex w-32 max-w-full min-w-0 items-center justify-end gap-2 sm:w-28">
      <StatusDot tone={look.tone} active={connection === "reconnecting"} />
      <span class="truncate">{look.label}</span>
    </span>
  {/if}
</p>
