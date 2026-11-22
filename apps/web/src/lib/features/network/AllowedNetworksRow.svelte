<script lang="ts">
  import { safeFailureDetail } from "@canopy/domain";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import type { NetworkAccessState } from "./network-access.svelte.ts";

  let { network }: { network: NetworkAccessState } = $props();

  const options = [
    { kind: "tailscale", label: "Tailscale" },
    { kind: "lan", label: "Local network" },
    { kind: "public", label: "Public internet" },
    { kind: "vpn", label: "Other VPNs" },
  ];

  const id = $props.id();
  const listFormat = new Intl.ListFormat("en", { type: "conjunction" });
  const allowed = $derived(network.status.allowedNetworks);
  const labels = $derived(options.flatMap(({ kind, label }) => (allowed.includes(kind) ? [label] : [])));
  const summary = $derived(labels.length === options.length ? "All networks" : listFormat.format(labels));

  let open = $state(false);
  let saving = $state(false);
  let failure = $state<{ detail: string }>();
  let draft = $state(options.map((option) => ({ ...option, checked: false })));

  const selected = $derived(draft.flatMap(({ kind, checked }) => (checked ? [kind] : [])));

  const canApply = $derived(
    !network.busy && selected.length > 0 && draft.some(({ kind, checked }) => checked !== allowed.includes(kind)),
  );

  function edit() {
    draft = options.map((option) => ({ ...option, checked: allowed.includes(option.kind) }));
    failure = undefined;
    open = true;
  }

  async function apply(event: SubmitEvent) {
    event.preventDefault();

    if (!canApply || saving) return;
    failure = undefined;
    saving = true;

    try {
      await network.update("set_allowed_networks", { allowedNetworks: selected });
      open = false;
    } catch (cause) {
      failure = { detail: cause instanceof Error ? safeFailureDetail(cause.message) : "" };
    } finally {
      saving = false;
    }
  }
</script>

<div>
  <SettingsRow title="Allowed networks" description={summary}>
    {#snippet control()}<Button
        size="sm"
        aria-label="Change allowed networks"
        aria-haspopup="dialog"
        disabled={!!network.error || network.busy}
        onclick={edit}>Change</Button
      >{/snippet}
  </SettingsRow>

  <Dialog
    bind:open
    title="Allowed networks"
    description="Select at least one network. Devices on unchecked networks will disconnect and need an allowed network to reconnect."
    dismissible={!saving}
  >
    <form {id} class="grid gap-4" onsubmit={apply}>
      <fieldset aria-label="Network types" class="grid gap-1" disabled={saving}>
        {#each draft as option (option.kind)}
          <Checkbox name="allowed-networks" label={option.label} value={option.kind} bind:checked={option.checked} />
        {/each}
      </fieldset>
      {#if failure}
        <Alert tone="error" title="Could not apply network settings">
          <p>Check your connection and try again.</p>
          {#if failure.detail}
            <Disclosure class="mt-2">
              {#snippet summary()}Show details{/snippet}
              <div class="flex min-w-0 items-start gap-2 py-2">
                <p class="min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap select-text">{failure.detail}</p>
                <CopyButton text={failure.detail} label="Copy error details" />
              </div>
            </Disclosure>
          {/if}
        </Alert>
      {/if}
    </form>
    {#snippet footer()}
      <DialogActions>
        <Button disabled={saving} onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" form={id} variant="primary" disabled={!canApply} loading={saving}>Apply</Button>
      </DialogActions>
    {/snippet}
  </Dialog>
</div>
