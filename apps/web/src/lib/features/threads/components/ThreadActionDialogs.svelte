<script lang="ts">
  import { tick } from "svelte";
  import { useThreadActions } from "../thread-actions.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import MoveDialog from "#lib/features/computers/MoveDialog.svelte";
  import type { ClassValue } from "svelte/elements";

  let { class: className }: { class?: ClassValue } = $props();
  const actions = useThreadActions();
  let title = $state("");
  let origin: HTMLElement | undefined;
  $effect(() => {
    if (actions.dialog) { title = actions.dialog.thread.title; origin = actions.returnFocus; }
    else if (origin?.isConnected) { const focus = origin; void tick().then(() => focus.focus({ preventScroll: true })); }
  });
  const sideCount = $derived(actions.dialog ? [...actions.overview.threads.values()].filter((t) => t.parentThreadId === actions.dialog?.thread.id && !t.deletedAt).length : 0);
</script>

<Dialog class={className} title={actions.dialog?.kind === "delete" ? "Delete thread?" : "Rename thread"}
  bind:open={() => Boolean(actions.dialog), (open) => { if (!open && !actions.saving) actions.dialog = undefined; }}>
  {#if actions.dialog?.kind === "rename"}
    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void actions.confirm(title); }}>
      <Field label="Thread title"><Input name="title" bind:value={title} maxlength={200} required data-autofocus /></Field>
      <div class="flex justify-end gap-2">
        <Button onclick={() => (actions.dialog = undefined)}>Cancel</Button>
        <Button type="submit" variant="primary" loading={actions.saving} disabled={!title.trim()}>Save</Button>
      </div>
    </form>
  {:else if actions.dialog}
    <div class="grid gap-4">
      <p class="text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">“{actions.dialog.thread.title}”{sideCount ? ` and ${sideCount} side ${sideCount === 1 ? 'thread' : 'threads'}` : ""} will be hidden. Running turns will be interrupted and schedules cancelled. You can undo this for a few seconds.</p>
      <div class="flex justify-end gap-2">
        <Button data-autofocus onclick={() => (actions.dialog = undefined)}>Cancel</Button>
        <Button variant="danger" loading={actions.saving} onclick={() => void actions.confirm()}>Delete thread</Button>
      </div>
    </div>
  {/if}
</Dialog>
<MoveDialog bind:open={() => Boolean(actions.moving), (open) => { if (!open) actions.moving = undefined; }}
  items={actions.moving ? [{ kind: "thread", id: actions.moving.id }] : []} name={actions.moving?.title ?? ""} />
