<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { enhance } from "$app/forms";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import ThreadSettingsFields from "./ThreadSettingsFields.svelte";

  /**
   * New side thread under `main` (same worker and directory). With "fork" it continues from the main
   * thread's history up to its last completed turn; without, it starts fresh with only the task.
   */
  let { open = $bindable(false), main, worker }: { open?: boolean; main: ui.Thread; worker: ui.Worker | undefined } = $props();

  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  let fork = $state(true);
  // A fresh idempotency key each time the dialog opens; resubmitting the same form reuses it.
  const clientRequestId = $derived(open ? crypto.randomUUID() : "");
</script>

<Dialog bind:open title="New side thread" description="Runs next to “{main.title}” in the same directory on {worker?.name ?? 'the same worker'}.">
  <form
    method="POST"
    action="?/createSideThread"
    class="grid gap-4"
    use:enhance={() => {
      busy = true;
      error = undefined;
      return async ({ result, update }) => {
        busy = false;
        if (result.type === "failure") error = String((result.data as { error?: unknown } | undefined)?.error ?? "Could not create the side thread");
        else if (result.type === "redirect") open = false;
        await update();
      };
    }}
  >
    <input type="hidden" name="parentThreadId" value={main.id} />
    <input type="hidden" name="clientRequestId" value={clientRequestId} />

    <Field label="Task" description="The first message of the side thread.">
      <Textarea name="message" rows={4} required data-autofocus placeholder="e.g. Review the changes in src/ for missing tests" />
    </Field>
    <Field label="Title" optional>
      <Input name="title" placeholder="Short label shown in the thread list" autocomplete="off" maxlength={200} />
    </Field>
    <Checkbox name="fork" label="Continue from the main thread's history" description="The side thread sees everything up to the main thread's last completed turn. Uncheck to start with only the task." bind:checked={fork} />
    <ThreadSettingsFields {worker} parent={main} />

    {#if worker && !worker.online}<Alert tone="warning">{worker.name} is offline. The side thread starts when it reconnects.</Alert>{/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}

    <DialogActions>
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" icon="arrows-right-left" loading={busy}>Start side thread</Button>
    </DialogActions>
  </form>
</Dialog>
