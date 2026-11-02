<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import { profileName } from "./profiles.ts";

  /**
   * Deleting a profile. One that threads use cannot be deleted (they would lose how to reach their model): the
   * dialog says so and offers to turn it off instead.
   */
  let {
    open = $bindable(false),
    profile,
    ondelete,
    ondisable,
  }: { open?: boolean; profile: ui.ProviderProfileSettings; ondelete: () => Promise<void>; ondisable: () => Promise<void> } = $props();

  let busy = $state(false);
  let failure = $state<string>();
  $effect.pre(() => {
    if (open) failure = undefined;
  });
  const inUse = $derived(profile.threadCount > 0);
  const name = $derived(profileName(profile));

  async function run(action: () => Promise<void>) {
    busy = true;
    failure = undefined;
    try {
      await action();
      open = false;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title={inUse ? `${name} is in use` : `Delete ${name}?`}
  description={inUse
    ? `${profile.threadCount} thread${profile.threadCount === 1 ? " runs" : "s run"} on this profile, so it cannot be deleted. Turn it off instead: new threads cannot pick it, and its threads say why they cannot run until you turn it back on.`
    : "Its key, variables and model choices are removed from this worker. This cannot be undone."}
>
  <div class="grid gap-4">
    {#if failure}<Alert tone="error">{failure}</Alert>{/if}
    <DialogActions>
      <Button onclick={() => (open = false)}>Cancel</Button>
      {#if inUse}
        {#if profile.enabled}<Button variant="primary" icon="pause" loading={busy} onclick={() => run(ondisable)}>Turn off</Button>{/if}
      {:else}
        <Button variant="danger" icon="trash" loading={busy} onclick={() => run(ondelete)}>Delete profile</Button>
      {/if}
    </DialogActions>
  </div>
</Dialog>
