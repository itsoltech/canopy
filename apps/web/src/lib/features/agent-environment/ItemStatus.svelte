<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { libraryItemState } from "@canopy/domain/environment-library";
  import Badge from "#lib/shared/ui/Badge.svelte";

  let {
    workers,
    selector,
    disabled = [],
    kind,
    id,
    harness,
    label = "",
    class: className,
  }: {
    workers: readonly ui.EnvironmentWorker[];
    selector?: ui.EnvironmentSelector;
    disabled?: readonly string[];
    kind: "instructions" | "skills" | "plugins";
    id: string;
    harness?: string;
    label?: string;
    class?: ClassValue;
  } = $props();

  const status = $derived(
    libraryItemState(
      workers,
      selector,
      kind,
      id,
      disabled.map((workerId) => ({ workerId, disabled: true })),
      harness,
    ),
  );
</script>

<div class={["flex flex-wrap items-center gap-1", className]} role="status">
  <Badge compact tone={status === "Synced" ? "emerald" : status === "Error" ? "rose" : "neutral"}>{status}</Badge>
  {#if label}<Badge compact tone="amber">{label}</Badge>{/if}
</div>
