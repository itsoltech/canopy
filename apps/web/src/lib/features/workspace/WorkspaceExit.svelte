<script lang="ts">
  import { onMount } from "svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { workspaceStore, workspaceVersion } from "./workspace.svelte.ts";

  let action = $state<"close" | "quit">();
  let saving = $state(false);

  const documents = $derived.by(() => {
    void workspaceVersion();

    return workspaceStore.documents().filter((document) => document.dirty || document.busy);
  });

  const busy = $derived(saving || documents.some((document) => document.busy));
  const errors = $derived(documents.map((document) => document.error).filter(Boolean));

  onMount(() => {
    let previous = false;

    const publish = () => {
      const blocked = workspaceStore.documents().some((document) => document.dirty || document.busy);

      if (blocked === previous) return;
      previous = blocked;
      void window.canopyDesktop?.setWorkspaceBlocked?.(blocked);
    };

    publish();
    const offStore = workspaceStore.subscribe(publish);
    const offClose = window.canopyDesktop?.onWorkspaceClose?.((value) => (action = value));

    return () => {
      offStore();
      offClose?.();
    };
  });

  async function finish(save: boolean) {
    if (!action || busy) return;
    saving = true;

    try {
      for (const document of documents) {
        if (save) {
          if (!(await document.save())) return;
        } else document.discard();
      }

      await window.canopyDesktop?.setWorkspaceBlocked?.(false);
      await window.canopyDesktop?.finishWorkspaceClose?.(action);
      action = undefined;
    } finally {
      saving = false;
    }
  }
</script>

<Dialog
  bind:open={
    () => Boolean(action),
    (open) => {
      if (!open) action = undefined;
    }
  }
  title="Save file changes?"
  dismissible={!busy}
>
  <p>Save or discard these edits before closing Canopy.</p>
  <ul class="my-3 max-h-48 overflow-auto text-sm">
    {#each documents as document}<li class="break-all">{document.path}</li>{/each}
  </ul>
  {#each errors as error}<Alert tone="error">{error}</Alert>{/each}
  <div class="mt-6 flex flex-wrap justify-end gap-2">
    <Button disabled={busy} onclick={() => (action = undefined)}>Keep editing</Button>
    <Button disabled={busy} variant="danger" onclick={() => void finish(false)}>Discard changes</Button>
    <Button disabled={busy} variant="primary" onclick={() => void finish(true)}>Save changes</Button>
  </div>
</Dialog>
