<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "./UpdateItem.svelte";
  import UpdateNotes from "./UpdateNotes.svelte";
  import { gatewayCurrent } from "./compact-updates.ts";
  import { updateBusy, updateStateLabel, type UpdatesState } from "./updates.svelte.ts";

  let { updates, class: className }: { updates: UpdatesState; class?: ClassValue } = $props();
  const snapshot = $derived(updates.snapshot);
  const current = $derived(!!snapshot && gatewayCurrent(snapshot));
  const busy = $derived(updateBusy(snapshot?.gatewayState ?? ""));
  const external = $derived(snapshot?.gatewayInstallKind !== "binary");
  const reason = $derived(snapshot?.gatewayReason.replace(/^Managed externally\.\s*/, "") ?? "");
</script>

{#if snapshot}
  <UpdateItem
    name="Gateway"
    icon="server"
    current={snapshot.gatewayVersion}
    target={snapshot.gatewayUpdateAvailable ? snapshot.availableVersion : ""}
    metadata={`${snapshot.channel}${external ? " · Managed externally" : ""}`}
    status={snapshot.checking
      ? "Checking"
      : busy || snapshot.gatewayState === "failed"
        ? updateStateLabel(snapshot.gatewayState, true)
        : current
          ? "Up to date"
          : snapshot.gatewayUpdateAvailable
            ? "Available"
            : "Not checked"}
    tone={snapshot.gatewayState === "failed" ? "rose" : busy ? "amber" : current ? "emerald" : "neutral"}
    error={snapshot.gatewayState === "failed" ? reason : ""}
    {busy}
    class={className}
  >
    {#snippet action()}
      {#if !external && (snapshot.gatewayUpdateAvailable || snapshot.gatewayState === "failed") && !busy}
        <IconButton
          size="sm"
          icon="arrow-up"
          label={snapshot.gatewayState === "failed" ? "Retry gateway update" : "Update gateway"}
          disabled={!!updates.pending || snapshot.run?.state === "running" || !snapshot.admin}
          onclick={() => void updates.manage({ action: "gateway" })}
        />
      {:else if reason}<IconButton size="sm" icon="information-circle" label={reason} />{/if}
    {/snippet}
    {#snippet children()}
      {#if snapshot.gatewayUpdateAvailable}<UpdateNotes
          current={snapshot.gatewayVersion}
          target={snapshot.availableVersion}
          channel={snapshot.channel}
          compact
        />{/if}
    {/snippet}
  </UpdateItem>
{/if}
