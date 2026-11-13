<script lang="ts">
  import type { MessageInitShape } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { appUpdateAvailable, bulkUpdatesAvailable } from "@canopy/domain/release/update-plan";
  import { homeAppComputer } from "@canopy/domain/release/update-actions";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import AppUpdateConfirmation from "./AppUpdateConfirmation.svelte";
  import type { UpdatesState } from "./updates.svelte.ts";

  let {
    updates,
    compact = false,
    request = { action: "update_all" },
    class: className,
  }: {
    updates: UpdatesState;
    compact?: boolean;
    request?: MessageInitShape<typeof ui.ManageUpdatesRequestSchema>;
    class?: ClassValue;
  } = $props();

  let confirming = $state(false);
  const snapshot = $derived(updates.snapshot);
  const running = $derived(snapshot?.run?.state === "running");
  const retry = $derived(request.action === "retry_step");
  const local = $derived(snapshot && homeAppComputer(snapshot));

  const restarts = $derived(
    retry
      ? snapshot?.run?.steps[request.updateStepIndex ?? 0]?.kind === "app"
      : snapshot?.appUpdateSupported && appUpdateAvailable(snapshot.app),
  );

  const label = $derived(running ? "Show update progress" : retry ? "Retry update" : "Update all");

  function act() {
    if (running) {
      void updates.reload();

      return;
    }

    if (restarts && local) confirming = true;
    else void updates.manage(request);
  }
</script>

{#if retry || running || (snapshot && bulkUpdatesAvailable(snapshot))}
  {#if compact}<IconButton
      icon={running ? "arrow-path" : "arrow-up"}
      size="sm"
      {label}
      disabled={!!updates.pending}
      onclick={act}
      class={className}
    />{:else}<Button size="sm" disabled={!!updates.pending} onclick={act} class={className}>{label}</Button>{/if}
{/if}
{#if local}<AppUpdateConfirmation bind:open={confirming} computer={local} {updates} {request} />{/if}
