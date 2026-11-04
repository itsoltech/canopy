<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ConflictDialog from "./ConflictDialog.svelte";

  /** Where a conflicted item is shown: what happened and the way to answer it. */
  let { conflict, class: className }: { conflict: ui.SharedConfigConflict; class?: ClassValue } = $props();
  const overview = useOverview();
  let open = $state(false);
</script>

<Alert class={className} tone="warning" title="Different on two computers">
  <p>
    {overview.machine(conflict.nodeId) ?? "Another computer"} has a different version. Each computer keeps its own until you
    choose.
  </p>
  <div class="pt-2"><Button size="sm" onclick={() => (open = true)}>Choose a version</Button></div>
</Alert>
<ConflictDialog {conflict} bind:open />
