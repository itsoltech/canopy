<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { awayReason, lastSeen } from "./computers.ts";

  /**
   * The linked computer a thread, project or worker lives on. Nothing for this computer's own: the badge
   * marks the exception, so lists without linked computers look as before.
   */
  let {
    nodeId,
    compact = false,
    class: className,
  }: { nodeId: string; compact?: boolean; class?: ClassValue } = $props();

  const overview = useOverview();
  const name = $derived(overview.machine(nodeId) ?? "");
  const computer = $derived(overview.computer(nodeId));
  const away = $derived(nodeId ? awayReason(computer) : undefined);
</script>

{#if nodeId}
  <Badge icon="link" {compact} class={className ?? "max-w-40"}
    ><span
      class="min-w-0 truncate"
      title={away
        ? `${away} ${lastSeen(computer)}. Read only.`
        : `On ${name}${computer?.viaName ? ` via ${computer.viaName}` : ""}`}
      >{name}{computer?.viaName ? ` via ${computer.viaName}` : ""}{away && !compact
        ? ` · ${lastSeen(computer)}`
        : ""}</span
    ><span class="sr-only">, linked computer{away ? ", read only" : ""}</span></Badge
  >
{/if}
