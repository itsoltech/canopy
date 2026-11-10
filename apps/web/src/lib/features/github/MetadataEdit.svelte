<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { metadataField, type MetadataKind } from "@canopy/domain/github-metadata";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import MarkdownEditor from "#lib/shared/ui/MarkdownEditor.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import MetadataChoices from "./MetadataChoices.svelte";
  import MetadataConflict from "./MetadataConflict.svelte";
  import { metadataEditor } from "./metadata-editors.ts";
  import { invalidations } from "./invalidations.ts";

  let {
    snapshot,
    kind,
    ondisplay,
    class: className,
  }: {
    snapshot: github.PullRequestSnapshot;
    kind: MetadataKind;
    ondisplay?: (value: github.PullRequestMetadata | undefined) => void;
    class?: ClassValue;
  } = $props();

  const editor = untrack(() => metadataEditor(snapshot, kind));
  let f = $state(editor.read());

  let open = $state(false),
    online = $state(true);

  const field = $derived(metadataField(kind));
  const blocked = $derived(f.busy || !online || snapshot.stale || editor.blocked);

  const label = $derived(
    kind === "title" ? "Edit title" : kind === "description" ? "Edit description" : `Edit ${kind}`,
  );

  $effect(() => editor.subscribe(() => (f = editor.read())));

  $effect(() => {
    editor.snapshot = snapshot;
    untrack(() => {
      if (!f.busy && f.display) editor.patch({ display: undefined });
    });
  });

  $effect(() => ondisplay?.(f.display));

  $effect(() => {
    const update = () => (online = navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });

  function choose() {
    open = !open;

    if (open) void editor.load();
  }

  async function apply() {
    if (blocked) return;

    if (await editor.apply()) {
      open = false;
      invalidations.publish(snapshot.summary?.ref?.id ?? "");
      invalidations.publish(`${snapshot.summary?.ref?.id}:metadata`);
    }
  }
</script>

<div class={["min-w-0", className]}>
  {#if kind === "title"}<IconButton
      icon="pencil-square"
      size="sm"
      {label}
      disabled={snapshot.stale || !online || f.busy}
      onclick={choose}
    />
  {:else}<Button
      size="sm"
      variant="ghost"
      aria-label={label}
      disabled={snapshot.stale || !online || f.busy}
      onclick={choose}>Edit</Button
    >{/if}
  {#snippet form()}
    <div class="grid min-w-0 gap-3 text-left">
      {#if f.current}
        {#if field === "details"}
          {#if kind === "title"}<Input
              name="metadata-title"
              aria-label="Pull request title"
              value={f.title}
              oninput={(event) => editor.patch({ title: event.currentTarget.value })}
              disabled={blocked}
              maxlength={256}
            />
          {:else}<MarkdownEditor
              name="metadata-description"
              label="Pull request description"
              bind:value={() => f.body, (body) => editor.patch({ body })}
              disabled={blocked}
            />{/if}
        {:else}
          {#if kind === "reviewers"}<SegmentedChoice
              label="Review request"
              options={[
                { value: "request", label: "Request" },
                { value: "re_request", label: "Re-request" },
                { value: "remove", label: "Remove" },
              ]}
              bind:value={() => f.reviewerAction, (reviewerAction) => editor.reviewAction(reviewerAction)}
              disabled={blocked}
            />
            <p class="text-sm text-zinc-500 dark:text-zinc-400">Requesting a review notifies them.</p>{/if}
          <MetadataChoices options={f.options} ids={f.ids} disabled={blocked} ontoggle={(id) => editor.toggle(id)} />
          {#if f.next}<Button size="sm" loading={f.busy} onclick={() => void editor.more()}>Load more choices</Button
            >{/if}
        {/if}
        {#if !f.current.actions.includes(field)}<p role="status" class="text-sm text-zinc-500">
            This account cannot edit this field. Check repository access.
          </p>{/if}
      {/if}
      {#if f.conflict}<MetadataConflict
          state={f}
          {kind}
          onrefresh={() => void editor.load(true)}
          disabled={f.busy}
        />{/if}
      {#if f.detail && !f.conflict}<p role="status" class="text-sm text-amber-700 dark:text-amber-400">
          {f.detail}
        </p>{/if}
      {#if f.receipt && ["uncertain", "in_flight"].includes(f.receipt.state)}<a
          class="text-sm text-brand-600 underline dark:text-brand-400"
          href={`https://github.com/${snapshot.summary?.ref?.repositoryName}/pull/${snapshot.summary?.ref?.number}`}
          target="_blank"
          rel="noreferrer">Check on GitHub</a
        ><Button size="sm" disabled={f.busy} onclick={() => void editor.load(true)}>Check current state</Button>{/if}
      {#if !f.current && !f.busy}<Button size="sm" onclick={() => void editor.load()}>Retry</Button>{/if}
      <div class="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={f.busy} onclick={() => (open = false)}>Cancel</Button><Button
          size="sm"
          variant="primary"
          loading={f.busy}
          disabled={blocked ||
            !f.current?.actions.includes(field) ||
            (kind === "title" && !f.title.trim()) ||
            (kind === "reviewers" && !f.ids.length)}
          onclick={() => void apply()}>Apply</Button
        >
      </div>
    </div>
  {/snippet}
  {#if field === "details"}
    {#if open}<div class="mt-2">{@render form()}</div>{/if}
  {:else}<Dialog bind:open title={label} dismissible={!f.busy}>{@render form()}</Dialog>{/if}
</div>
