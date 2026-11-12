<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { updatesAvailable } from "./compact-updates.ts";
  import type { UpdatesState } from "./updates.svelte.ts";

  let { run, updates, class: className }: { run: ui.UpdateRun; updates: UpdatesState; class?: ClassValue } = $props();
</script>

{#if ["failed", "blocked"].includes(run.state)}
  <div class={["flex flex-wrap gap-2", className]}>
    {#if updates.snapshot && updatesAvailable(updates.snapshot)}
      <Button size="sm" disabled={!!updates.pending} onclick={() => void updates.manage({ action: "update_all" })}>
        Request again
      </Button>
    {/if}
    <Button
      size="sm"
      disabled={!!updates.pending}
      onclick={() => void updates.manage({ action: "dismiss_run", desktopRequestId: run.id })}>Dismiss</Button
    >
  </div>
{/if}
