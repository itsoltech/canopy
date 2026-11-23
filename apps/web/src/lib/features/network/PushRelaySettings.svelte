<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { onMount } from "svelte";
  import { HttpError, requestJson, type JsonBody } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import { useConnectionRequest } from "./connection-request.svelte.ts";
  import PushRelayDialog from "./PushRelayDialog.svelte";

  let { gatewayScope }: { gatewayScope: string } = $props();
  const endpoint = $derived(`/api/push-relay?gateway=${encodeURIComponent(gatewayScope)}`);

  const relay = useConnectionRequest(create(ui.PushRelaySettingsSchema), async () =>
    decode(ui.PushRelaySettingsSchema, await requestJson("GET", endpoint)),
  );

  let editOpen = $state(false);
  let changeOpen = $state(false);
  let change = $state<"managed" | "remove">("remove");
  let busy = $state(false);
  let error = $state("");
  let inlineError = $state("");

  const custom = $derived(relay.data.origin);
  const managedOrigin = $derived(relay.data.managedOrigin);
  const managedEnabled = $derived(managedOrigin ? relay.data.managedEnabled : relay.data.managedAvailable && !custom);
  const managedByDefault = $derived(managedOrigin ? relay.data.managedByDefault : relay.data.managedAvailable);
  const canUseManaged = $derived(!!managedOrigin || managedByDefault);

  const title = $derived.by(() => {
    if (relay.error) return "Could not load relay settings";

    if (!relay.loaded) return "Loading relay settings…";

    if (custom) return "Custom relay";

    return managedEnabled ? "Canopy relay" : "Not configured";
  });

  const description = $derived.by(() => {
    if (relay.error) return relay.error;

    if (!relay.loaded || custom) return undefined;

    if (managedEnabled) return "Turn on System notifications on a paired phone to receive alerts.";

    return canUseManaged ? undefined : "Get an HTTPS address and token from your relay operator.";
  });

  const changeLabel = $derived(change === "managed" ? "Use Canopy relay" : "Remove relay");
  const displayedOrigin = $derived(custom || (managedEnabled ? managedOrigin : ""));

  onMount(() => void relay.reload());

  function confirmChange(action: "managed" | "remove") {
    error = "";
    change = action;
    changeOpen = true;
  }

  function useManaged() {
    return update(managedOrigin ? { useManaged: true } : { remove: true }, !changeOpen);
  }

  async function update(body: JsonBody, inline = false) {
    if (busy) return;
    busy = true;
    error = "";
    inlineError = "";

    try {
      relay.set(decode(ui.PushRelaySettingsSchema, await requestJson("PUT", endpoint, body)));
      editOpen = false;
      changeOpen = false;
    } catch (cause) {
      const message =
        cause instanceof HttpError ? cause.message : "Check your connection to the gateway and try again.";

      if (inline) inlineError = message;
      else error = message;
    } finally {
      busy = false;
    }
  }
</script>

<SettingsGroup title="Mobile push relay" class="[&_.settings-row-control]:max-w-full">
  <SettingsRow {title} {description}>
    {#if displayedOrigin}<p class="text-sm/5 wrap-anywhere text-zinc-500 dark:text-zinc-400">
        {displayedOrigin}
      </p>{/if}
    {#snippet control()}
      {#if relay.error}<Button size="sm" loading={relay.loading} onclick={() => void relay.reload()}>Retry</Button>
      {:else}
        <div class="flex flex-wrap gap-2">
          {#if !managedByDefault && (custom || managedEnabled)}<Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onclick={() => confirmChange("remove")}>Remove relay</Button
            >{/if}
          {#if canUseManaged && !managedEnabled}<Button
              size="sm"
              variant={custom ? "secondary" : "primary"}
              disabled={busy}
              loading={busy && !changeOpen && !editOpen}
              onclick={() => (custom ? confirmChange("managed") : void useManaged())}>Use Canopy relay</Button
            >{/if}
          <Button
            size="sm"
            disabled={!relay.loaded || busy}
            onclick={() => {
              error = "";
              editOpen = true;
            }}>{custom ? "Edit relay" : "Use custom relay"}</Button
          >
        </div>
      {/if}
    {/snippet}
  </SettingsRow>
  {#if inlineError}<Alert tone="error" title="Could not enable the Canopy relay">{inlineError}</Alert>{/if}
</SettingsGroup>

<PushRelayDialog bind:open={editOpen} settings={relay.data} {busy} {error} onsave={(body) => void update(body)} />
<Dialog
  bind:open={changeOpen}
  title={`${changeLabel}?`}
  description={change === "managed"
    ? "This replaces the custom relay. Paired phones activate the Canopy relay the next time they open Canopy."
    : "Removing the relay pauses push delivery. Paired phones keep their notification choices."}
  dismissible={!busy}
>
  <div class="grid gap-4">
    {#if error}<Alert tone="error" title="Could not change the relay">{error}</Alert>{/if}
    <DialogActions>
      <Button data-autofocus disabled={busy} onclick={() => (changeOpen = false)}>Cancel</Button>
      <Button
        variant={change === "managed" ? "primary" : "danger"}
        loading={busy}
        onclick={() => void (change === "managed" ? useManaged() : update({ remove: true }))}>{changeLabel}</Button
      >
    </DialogActions>
  </div>
</Dialog>
