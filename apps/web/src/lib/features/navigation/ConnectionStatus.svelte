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

<p class={["flex items-center gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]} role="status">
  <StatusDot tone={look.tone} active={connection === "reconnecting"} />
  <span class="min-w-32 text-right sm:min-w-28">{look.label}</span>
</p>
