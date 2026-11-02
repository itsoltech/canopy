<script lang="ts">
  import { untrack } from "svelte";
  import type { ModelOption } from "#lib/features/models/catalog.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import ProviderModelFields from "./ProviderModelFields.svelte";
  import type { BotProviderInstance } from "./draft.ts";

  /**
   * Another provider instance, model or effort for an existing bot (after "Change model" on a failed
   * reply). Offers only models the bot can call (the caller's `botWizardInstances`). `onsave` rejects with
   * an Error to keep the dialog open with its message.
   */
  export interface BotModelChoice {
    providerInstanceId: string;
    model: string;
    effort: string | undefined;
  }

  let { open = $bindable(false), botName, instances, initial, onsave }: {
    open?: boolean;
    botName: string;
    instances: readonly BotProviderInstance[];
    initial: BotModelChoice;
    onsave: (choice: BotModelChoice) => Promise<void>;
  } = $props();

  let instanceId = $state("");
  let option = $state.raw<ModelOption>();
  let effort = $state<string>();
  let busy = $state(false);
  let error = $state<string>();
  let wasOpen = false;

  $effect(() => {
    if (open && !wasOpen) untrack(() => {
      instanceId = initial.providerInstanceId;
      option = instances.find((i) => i.id === initial.providerInstanceId)?.models.find((m) => m.model === initial.model);
      effort = initial.effort;
      error = undefined;
    });
    wasOpen = open;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !option) return;
    busy = true;
    try {
      await onsave({ providerInstanceId: instanceId, model: option.model, effort });
      open = false;
    } catch (cause) {
      error = (cause instanceof Error && cause.message) || "Could not change the model. Please try again.";
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title="Change model" description="{botName} keeps its conversation; new replies use this model." dismissible={!busy}>
  <form class="grid gap-5" onsubmit={submit} aria-busy={busy || undefined}>
    <ProviderModelFields {instances} bind:instanceId bind:option bind:effort disabled={busy} />
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button disabled={busy} onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!option}>Use this model</Button>
    </DialogActions>
  </form>
</Dialog>
