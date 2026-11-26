<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { libraryItemState } from "@canopy/domain/environment-library";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    workers,
    selector,
    disabled = [],
    kind,
    id,
    harness,
    label = "",
    name = "",
    onreview,
    class: className,
  }: {
    workers: readonly ui.EnvironmentWorker[];
    selector?: ui.EnvironmentSelector;
    disabled?: readonly string[];
    kind: "instructions" | "skills" | "plugins";
    id: string;
    harness?: string;
    label?: string;
    name?: string;
    onreview?: () => void;
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

  const review = $derived(
    status === "Local conflict"
      ? "Resolve local conflict"
      : status === "Error"
        ? "Review sync error"
        : status === "Kept locally"
          ? "Review kept copy"
          : "",
  );
</script>

<div class={["flex flex-wrap items-center gap-1", className]} role={onreview && review ? undefined : "status"}>
  {#if onreview && review}
    <Button
      size="sm"
      variant={status === "Kept locally" ? "ghost" : "secondary"}
      aria-label={`${review} for ${name}`}
      onclick={onreview}>{review}</Button
    >
  {:else}
    <Badge compact tone={status === "Synced" ? "emerald" : status === "Error" ? "rose" : "neutral"}>{status}</Badge>
  {/if}
  {#if label}<Badge compact tone="amber">{label}</Badge>{/if}
</div>
