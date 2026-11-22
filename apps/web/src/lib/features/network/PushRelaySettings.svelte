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

  const endpoint = "/api/push-relay";

  const relay = useConnectionRequest(create(ui.PushRelaySettingsSchema), async () =>
    decode(ui.PushRelaySettingsSchema, await requestJson("GET", endpoint)),
  );

  let editOpen = $state(false);
  let removeOpen = $state(false);
  let busy = $state(false);
  let error = $state("");

  const title = $derived.by(() => {
    if (relay.error) return "Could not load relay settings";

    if (!relay.loaded) return "Loading relay settings…";

    if (relay.data.origin) return "Custom relay";

    return relay.data.managedAvailable ? "Canopy relay" : "Not configured";
  });

  const description = $derived.by(() => {
    if (relay.error) return relay.error;

    if (!relay.loaded || relay.data.origin) return undefined;

    return relay.data.managedAvailable
      ? "Turn on System notifications on a paired phone to activate this relay."
      : "Get an HTTPS address and token from your relay operator.";
  });

  const removeLabel = $derived(relay.data.managedAvailable ? "Use Canopy relay" : "Remove relay");

  onMount(() => void relay.reload());

  async function update(body: JsonBody) {
    if (busy) return;
    busy = true;
    error = "";

    try {
      relay.set(decode(ui.PushRelaySettingsSchema, await requestJson("PUT", endpoint, body)));
      editOpen = false;
      removeOpen = false;
    } catch (cause) {
      error = cause instanceof HttpError ? cause.message : "Check your connection to the gateway and try again.";
    } finally {
      busy = false;
    }
  }
</script>

<SettingsGroup title="Mobile push relay">
  <SettingsRow {title} {description}>
    {#if relay.data.origin}<p class="text-sm/5 wrap-anywhere text-zinc-500 dark:text-zinc-400">
        {relay.data.origin}
      </p>{/if}
    {#snippet control()}
      {#if relay.error}<Button size="sm" loading={relay.loading} onclick={() => void relay.reload()}>Retry</Button>
      {:else}
        <Button
          size="sm"
          disabled={!relay.loaded}
          onclick={() => {
            error = "";
            editOpen = true;
          }}>{relay.data.origin ? "Edit relay" : "Use custom relay"}</Button
        >
        {#if relay.data.origin}<Button
            size="sm"
            variant="ghost"
            onclick={() => {
              error = "";
              removeOpen = true;
            }}>{removeLabel}</Button
          >{/if}
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsGroup>

<PushRelayDialog bind:open={editOpen} settings={relay.data} {busy} {error} onsave={(body) => void update(body)} />
<Dialog
  bind:open={removeOpen}
  title={`${removeLabel}?`}
  description={relay.data.managedAvailable
    ? "Paired phones keep their choices. They activate the Canopy relay the next time Canopy opens."
    : "Removing the relay pauses push delivery. Paired phones keep their notification choices."}
  dismissible={!busy}
>
  <div class="grid gap-4">
    {#if error}<Alert tone="error" title="Could not remove relay">{error}</Alert>{/if}
    <DialogActions>
      <Button data-autofocus disabled={busy} onclick={() => (removeOpen = false)}>Cancel</Button>
      <Button variant="danger" loading={busy} onclick={() => void update({ remove: true })}>{removeLabel}</Button>
    </DialogActions>
  </div>
</Dialog>
