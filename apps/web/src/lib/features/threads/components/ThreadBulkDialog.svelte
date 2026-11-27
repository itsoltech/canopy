<script lang="ts">
  import { tick } from "svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import { useThreadActions } from "../thread-actions.svelte.ts";
  import { threadCount } from "../thread-bulk-actions.svelte.ts";

  /** Confirms archiving or deleting the sidebar's selected threads (Settings → Threads → Confirmations). */
  const actions = useThreadActions();
  const bulk = actions.bulk;

  // The last request stays on screen while the dialog closes.
  let shown = $state.raw(bulk.dialog);

  $effect.pre(() => {
    if (bulk.dialog) shown = bulk.dialog;
  });

  const dialog = $derived(bulk.dialog ?? shown);
  const count = $derived(threadCount(dialog?.threads.length ?? 0));

  // Side threads that go with the chosen ones and are not chosen themselves.
  const sideCount = $derived.by(() => {
    const ids = new Set(dialog?.threads.map((thread) => thread.id));

    return [...actions.overview.threads.values()].filter(
      (thread) => thread.parentThreadId && ids.has(thread.parentThreadId) && !ids.has(thread.id) && !thread.deletedAt,
    ).length;
  });

  const including = $derived(sideCount ? ` and ${sideCount} side ${sideCount === 1 ? "thread" : "threads"}` : "");
  let origin: HTMLElement | undefined;

  $effect(() => {
    if (bulk.dialog) origin = bulk.returnFocus;
    else if (origin?.isConnected) {
      const focus = origin;
      void tick().then(() => focus.focus({ preventScroll: true }));
    }
  });
</script>

<Dialog
  title={dialog?.kind === "delete" ? `Delete ${count}?` : `Archive ${count}?`}
  bind:open={
    () => Boolean(bulk.dialog),
    (open) => {
      if (!open && !bulk.saving) bulk.dialog = undefined;
    }
  }
>
  {#if dialog}
    <div class="grid gap-4">
      <p class="text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
        {dialog.kind === "delete"
          ? `This deletes ${count}${including}. Running turns stop. Canopy cancels their schedules. Canopy permanently deletes their history after 31 days. Workspace files stay unchanged. You can undo this for a few seconds.`
          : `This archives ${count}${including}. Running turns stop. Canopy cancels their schedules. You can undo this for a few seconds.`}
      </p>
      <div class="flex justify-end gap-2">
        <Button data-autofocus onclick={() => (bulk.dialog = undefined)}>Cancel</Button>
        <Button
          variant={dialog.kind === "delete" ? "danger" : "primary"}
          loading={bulk.saving}
          onclick={() => void bulk.confirm()}
          >{dialog.kind === "delete" ? `Delete ${count}` : `Archive ${count}`}</Button
        >
      </div>
    </div>
  {/if}
</Dialog>
