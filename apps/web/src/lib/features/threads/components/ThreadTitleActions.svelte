<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import SwapText from "#lib/shared/ui/SwapText.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { updateThread } from "../api.ts";
  import { requestTitleRegeneration } from "../title-actions.ts";

  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  let editing = $state(false);
  let title = $state("");
  let saving = $state(false);
  const closed = $derived(thread.status === "archived");
  // From the click until the gateway reports the generation (and then until it ends): the button spins and
  // the title shimmers, so a request never looks ignored.
  let requested = $state(false);
  const generating = $derived(thread.titleGenerating || requested);
  $effect(() => {
    if (thread.titleGenerating) requested = false;
  });

  async function regenerate() {
    requested = true;
    try {
      await requestTitleRegeneration(thread.id);
    } finally {
      // The thread update with titleGenerating normally arrives first; without it (a failure) stop here.
      setTimeout(() => (requested = false), 1500);
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    try {
      await updateThread(thread.id, { title: title.trim() });
      editing = false;
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not rename the thread", { tone: "error" });
    } finally { saving = false; }
  }
</script>

<section aria-label="Thread title" class={["grid min-w-0 gap-2 p-3", className]}>
  {#if editing}
    <form class="grid gap-2" onsubmit={save}>
      <Field label="Thread title"><Input name="title" bind:value={title} maxlength={200} required onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); editing = false; } }} /></Field>
      <div class="flex flex-wrap justify-end gap-2">
        <Button size="sm" onclick={() => (editing = false)}>Cancel</Button>
        <Button size="sm" type="submit" loading={saving} disabled={!title.trim()}>Save</Button>
      </div>
    </form>
  {:else}
    <div class="flex min-w-0 items-center gap-2 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
      <SwapText text={thread.title || "New thread"} class={["min-w-0 flex-1 overflow-hidden", generating && "shimmer"]} />
      <IconButton icon="pencil-square" size="sm" label="Rename thread" disabled={closed} onclick={() => { title = thread.title; editing = true; }} />
    </div>
    <div><Button size="sm" icon="arrow-path" loading={generating} disabled={closed || generating} onclick={regenerate}>{generating ? "Generating title…" : "Regenerate title"}</Button></div>
  {/if}
</section>
