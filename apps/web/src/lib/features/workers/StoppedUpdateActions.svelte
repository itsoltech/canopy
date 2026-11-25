<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { UpdatesState } from "./updates.svelte.ts";
  import UpdateActionButton from "./UpdateActionButton.svelte";

  let { run, updates, class: className }: { run: ui.UpdateRun; updates: UpdatesState; class?: ClassValue } = $props();
</script>

{#if ["failed", "blocked"].includes(run.state)}
  <div class={["flex flex-wrap gap-2", className]}>
    <UpdateActionButton {updates} request={{ action: "retry_failed", desktopRequestId: run.id }} />
    <Button
      size="sm"
      disabled={!updates.writable || !!updates.pending || updates.gatewayTransition}
      onclick={() => void updates.manage({ action: "dismiss_run", desktopRequestId: run.id })}>Dismiss run</Button
    >
  </div>
{/if}
