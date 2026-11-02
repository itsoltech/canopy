<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { Tone } from "#lib/shared/ui/tone.ts";
  import type { OverviewConnection } from "#lib/features/overview/overview-state.svelte.ts";

  /** Gateway connection of this tab, announced politely when it changes. */
  let { connection, class: className }: { connection: OverviewConnection; class?: ClassValue } = $props();
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
<p class={["flex items-center text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]} role="status">
  <span class="flex min-w-32 items-center justify-end gap-2 sm:min-w-28">
    <StatusDot tone={look.tone} active={connection === "reconnecting"} />
    {look.label}
  </span>
</p>
