<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";

  let {
    note,
    formId,
    busy,
    onsave,
  }: {
    note: ui.MemoryNote;
    formId: string;
    busy: boolean;
    onsave: (draft: Pick<ui.MemoryNote, "title" | "body" | "aliases" | "pinned">) => void;
  } = $props();

  let title = $state(untrack(() => note.title));
  let body = $state(untrack(() => note.body));
  let pinned = $state(untrack(() => note.pinned));
  let aliases = $state(untrack(() => note.aliases.map((value, key) => ({ key, value }))));
  let nextKey = untrack(() => aliases.length);
  let attempted = $state(false);
  let form: HTMLFormElement;

  async function addAlias() {
    const key = nextKey++;
    aliases.push({ key, value: "" });
    await tick();
    form.querySelector<HTMLElement>(`[name="alias-${key}"]`)?.focus();
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    attempted = true;

    if (!title.trim() || !body.trim() || busy) return;
    onsave({
      title: title.trim(),
      body: body.trim(),
      pinned,
      aliases: aliases.map((alias) => alias.value.trim()).filter(Boolean),
    });
  }
</script>

<form id={formId} bind:this={form} onsubmit={submit}>
  <fieldset disabled={busy} class="grid min-w-0 gap-4">
    <Field label="Title" error={attempted && !title.trim() ? "Enter a title." : undefined}>
      <Textarea name="title" bind:value={title} maxlength={160} required rows={1} data-autofocus />
    </Field>
    <Field label="Body" error={attempted && !body.trim() ? "Enter the note text." : undefined}>
      <Textarea name="body" bind:value={body} maxlength={4000} rows={6} required />
    </Field>
    <fieldset class="grid min-w-0 gap-1.5">
      <legend class="mb-1 text-base/6 font-medium sm:text-sm/6">Aliases</legend>
      <p class="text-sm/5 text-muted">Other names agents and bots can use to find this note.</p>
      {#each aliases as alias, i (alias.key)}
        <div class="flex min-w-0 items-start gap-2">
          <div class="min-w-0 flex-1">
            <Textarea
              name={`alias-${alias.key}`}
              bind:value={alias.value}
              maxlength={80}
              rows={1}
              aria-label={`Alias ${i + 1}`}
            />
          </div>
          <IconButton
            icon="x-mark"
            label={`Remove alias ${i + 1}`}
            onclick={() => (aliases = aliases.filter((item) => item.key !== alias.key))}
          />
        </div>
      {/each}
      <div><Button size="sm" icon="plus" disabled={aliases.length >= 8} onclick={addAlias}>Add alias</Button></div>
    </fieldset>
    <Checkbox name="pinned" label="Pin note" bind:checked={pinned} />
  </fieldset>
</form>
