<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import { providerName, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useThreadModels } from "#lib/features/models/model-catalog.svelte.ts";
  import ModelControls from "#lib/features/models/ModelControls.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import { updateThread } from "../api.ts";

  /**
   * The thread's default model and reasoning effort (UpdateThread): what turns run with when the
   * composer sends no choice of its own. The thread keeps its provider and profile, so only their models
   * are offered. Saving sends only what changed; the new defaults arrive through the thread's stream.
   */
  let { open = $bindable(false), thread, worker }: { open?: boolean; thread: ui.Thread; worker: ui.Worker | undefined } = $props();

  const offer = useThreadModels(() => ({ thread, worker }));

  // Edits start from the thread's defaults each time the dialog opens.
  let edit = $state<{ option?: ModelOption | undefined; effort?: string | undefined }>({});
  $effect.pre(() => {
    if (open) edit = { option: undefined, effort: untrack(() => thread.effort) || undefined };
  });
  const option = $derived(edit.option ?? offer.current);
  let busy = $state(false);
  let error = $state<string>();

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const change = {
      ...(option && offer.current && option.key !== offer.current.key && { model: option.model }),
      ...((edit.effort ?? "") !== thread.effort && { effort: edit.effort ?? "" }),
    };
    if (Object.keys(change).length === 0) return void (open = false);
    busy = true;
    error = undefined;
    try {
      await updateThread(thread.id, change);
      open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title="Model and effort" description="Turns use these unless you choose otherwise in the composer for a message.">
  <form class="grid gap-4" onsubmit={save}>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-1.5 pl-3 ring-1 ring-zinc-950/10 dark:ring-white/10">
      {#if option}
        <span class="flex min-w-0 items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
          <ProviderIcon provider={option.provider} />
          <span class="truncate">{providerName(option.provider)} · {option.profileName}</span>
        </span>
        <ModelControls
          options={offer.options}
          bind:option={() => option, (next) => (edit = { ...edit, option: next })}
          bind:effort={() => edit.effort, (next) => (edit = { ...edit, effort: next })}
          workerId={thread.workerId}
          class="ml-auto"
        />
      {:else}
        <p class="text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">This thread's agent has no model choice.</p>
      {/if}
    </div>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!option}>Save</Button>
    </DialogActions>
  </form>
</Dialog>
