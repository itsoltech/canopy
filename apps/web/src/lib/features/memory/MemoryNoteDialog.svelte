<script lang="ts">
  import { tick } from "svelte";
  import type { ui } from "@canopy/contracts";
  import { noteScopeLabel } from "@canopy/domain/memory-scopes";
  import { formatEnglishDateTime, isoDateTime } from "#lib/shared/format.ts";
  import { HttpError } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import MemoryNoteForm from "./MemoryNoteForm.svelte";
  import { updateMemoryNote, deleteMemoryNote } from "./api.ts";

  let {
    onchange,
    onreload,
  }: {
    onchange: (id: string, updated?: ui.MemoryNote) => void;
    onreload: () => void;
  } = $props();

  let note = $state.raw<ui.MemoryNote>();
  let open = $state(false);

  type Mode = "preview" | "edit" | "delete";

  let mode = $state<Mode>("preview");
  let busy = $state(false);
  let failure = $state<"conflict" | "missing" | "request">();
  let detail = $state("");
  const id = $props.id();

  export function inspect(next: ui.MemoryNote) {
    note = next;
    mode = "preview";
    failure = undefined;
    open = true;
  }

  async function show(view: Mode) {
    mode = view;
    failure = undefined;
    await tick();

    const target =
      view === "edit"
        ? document.getElementById(`${id}-form`)?.querySelector("textarea")
        : document.getElementById(`${id}-${view}`);

    target?.focus();
  }

  async function apply(draft?: Pick<ui.MemoryNote, "title" | "body" | "aliases" | "pinned">) {
    if (!note || busy || failure === "missing" || failure === "conflict") return;
    busy = true;
    failure = undefined;

    try {
      if (draft) {
        const updated = await updateMemoryNote(note, draft);
        note = updated;
        onchange(updated.id, updated);
        await show("preview");
      } else {
        await deleteMemoryNote(note);
        open = false;
        onchange(note.id);
      }
    } catch (cause) {
      failure =
        cause instanceof HttpError && cause.status === 409
          ? "conflict"
          : cause instanceof HttpError && cause.status === 404
            ? "missing"
            : "request";
      detail = cause instanceof Error ? cause.message : "";
    } finally {
      busy = false;
    }
  }

  function close() {
    open = false;

    if (failure === "conflict" || failure === "missing") onreload();
  }
</script>

{#if note}
  <Dialog
    bind:open={
      () => open,
      (next) => {
        if (!next) close();
      }
    }
    dismissible={!busy}
    title={mode === "edit" ? "Edit note" : mode === "delete" ? "Delete note?" : note.title}
    description={noteScopeLabel(note)}
  >
    <div class="grid min-w-0 gap-4">
      {#if mode === "edit"}
        <MemoryNoteForm {note} formId={`${id}-form`} {busy} onsave={apply} />
      {:else if mode === "delete"}
        <p class="text-base/6 wrap-anywhere whitespace-pre-wrap sm:text-sm/6">
          This permanently deletes “{note.title}”.
        </p>
      {:else}
        <p class="text-base/6 wrap-anywhere whitespace-pre-wrap select-text sm:text-sm/6">{note.body}</p>
        {#if note.aliases.length}
          <div>
            <h3 class="text-sm/5 font-medium">Aliases</h3>
            <ul role="list" class="mt-1 grid gap-1 text-base/6 text-muted sm:text-sm/6">
              {#each note.aliases as alias}<li class="wrap-anywhere whitespace-pre-wrap select-text">{alias}</li>{/each}
            </ul>
          </div>
        {/if}
        <div class="flex flex-wrap items-center gap-2 text-sm/5 text-muted sm:text-xs/5">
          {#if note.pinned}<Badge compact>Pinned</Badge>{/if}
          {#if note.createdAt}<time datetime={isoDateTime(note.createdAt)}
              >Created {formatEnglishDateTime(note.createdAt)}</time
            >{/if}
          {#if note.updatedAt && (!note.createdAt || note.revision > 1)}<time datetime={isoDateTime(note.updatedAt)}
              >Updated {formatEnglishDateTime(note.updatedAt)}</time
            >{/if}
        </div>
      {/if}
      {#if failure === "conflict" || failure === "missing"}
        <Alert tone="warning" title={failure === "conflict" ? "This note changed" : "This note no longer exists"}>
          {mode === "edit"
            ? "Copy any edits you want to keep before reloading the list."
            : "Reload the list to see the latest notes."}
        </Alert>
      {:else if failure === "request"}
        <Alert tone="error" title={mode === "delete" ? "Could not delete the note" : "Could not save the note"}>
          Check your connection and try again.
          {#if detail}
            <Disclosure class="mt-2">
              {#snippet summary()}Show details{/snippet}
              <div class="mt-1 flex min-w-0 items-start gap-2">
                <p class="min-w-0 flex-1 wrap-anywhere select-text">{detail}</p>
                <CopyButton text={detail} label="Copy error details" />
              </div>
            </Disclosure>
          {/if}
        </Alert>
      {/if}
    </div>
    {#snippet footer()}
      <DialogActions>
        {#if failure === "conflict" || failure === "missing"}
          <Button variant="primary" onclick={close}>Reload notes</Button>
        {:else if mode === "preview"}
          <Button variant="danger" onclick={() => show("delete")}>Delete note</Button>
          <Button id={`${id}-preview`} variant="primary" onclick={() => show("edit")}>Edit note</Button>
        {:else}
          <Button id={`${id}-delete`} disabled={busy} onclick={() => show("preview")}>Cancel</Button>
          {#if mode === "edit"}
            <Button form={`${id}-form`} type="submit" variant="primary" loading={busy}>Save changes</Button>
          {:else}
            <Button variant="danger" loading={busy} onclick={() => apply()}>Delete note</Button>
          {/if}
        {/if}
      </DialogActions>
    {/snippet}
  </Dialog>
{/if}
