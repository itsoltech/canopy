<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";

  /**
   * The one confirmation Full access gets each time it is picked (composer, thread defaults): `pending` is the
   * pick waiting for it; confirming runs it, Cancel or Escape drops it. The Permissions dialog asks with its own
   * Save button instead.
   */
  let { pending = $bindable() }: { pending?: (() => void) | undefined } = $props();

  function confirm() {
    const run = pending;
    pending = undefined;
    run?.();
  }
</script>

<Dialog bind:open={() => pending !== undefined, (open) => !open && (pending = undefined)} title="Turn on full access?">
  <div class="grid gap-4">
    <p class="text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
      The agent edits files and runs commands without asking. No sandbox keeps it in the workspace. It can change any
      file this computer’s worker can reach and use the network.
    </p>
    <DialogActions>
      <Button data-autofocus onclick={() => (pending = undefined)}>Cancel</Button>
      <Button variant="danger" onclick={confirm}>Turn on full access</Button>
    </DialogActions>
  </div>
</Dialog>
