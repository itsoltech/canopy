<script lang="ts">
  import { formatSize } from "@canopy/domain";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { clearSelection, confineSelectAll } from "#lib/shared/ui/select-all.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { fileName } from "#lib/shared/ui/markdown/file-paths.ts";
  import CodeEditor from "./CodeEditor.svelte";
  import FileContentView from "./FileContentView.svelte";
  import { openInApp, type FileTarget } from "./file-links.svelte.ts";
  import { EDIT_LIMIT_BYTES, FileViewerState } from "./file-viewer.svelte.ts";
  import FileLookup from "./FileLookup.svelte";

  /** A thread's file: read with highlighting (Markdown rendered), edit, save, delete or open in the default app. */
  let { target, onclose }: { target: FileTarget; onclose: () => void } = $props();

  // The parent keys this component by its target: another file is a new viewer.
  const viewer = $derived(new FileViewerState(target));
  let open = $state(true);
  let confirmDelete = $state(false);
  let confirmClose = $state(false);
  const name = $derived(fileName(target.path));
  const markdown = $derived(/\.(md|markdown|mdx)$/i.test(name));
  const mode = $derived(devicePreferences.values.attachmentMarkdown);

  const detail = $derived(
    [
      viewer.lookup?.relativePath
        ? viewer.lookup.relativePath === name
          ? `./${name}`
          : viewer.lookup.relativePath
        : "Workspace file",
      viewer.lookup?.computer,
    ]
      .filter(Boolean)
      .join(" · "),
  );

  $effect(() => {
    void viewer.load();
  });

  // Closing with unsaved changes asks first; the dialog itself stays open until the user decides.
  $effect(() => {
    if (open) return;

    if (viewer.dirty) {
      open = true;
      confirmClose = true;
    } else close();
  });

  /** Leaves no selection behind in the page (Mod+A inside the viewer). */
  function close() {
    clearSelection();
    onclose();
  }

  async function save() {
    if (await viewer.save()) toast("Saved");
  }

  async function remove() {
    if (!(await viewer.remove())) return;
    confirmDelete = false;
    toast(`Deleted ${name}`);
    close();
  }
</script>

<Dialog
  bind:open
  title={name}
  description={detail}
  size="output"
  fullscreen
  dismissible={!viewer.busy}
  onkeydown={confineSelectAll}
>
  <div class="grid min-w-0 gap-3">
    <div class="flex flex-wrap items-center gap-2">
      {#if viewer.editing}
        <Button size="sm" variant="primary" disabled={!viewer.dirty || viewer.busy} onclick={save}>Save</Button>
        <Button size="sm" variant="ghost" disabled={viewer.busy} onclick={() => viewer.discard()}
          >{viewer.dirty ? "Discard changes" : "Stop editing"}</Button
        >
        <!-- Reserved width: the badge appears on the first edit without moving the actions after it. -->
        <span class="inline-flex min-w-36 items-center"
          >{#if viewer.dirty}<Badge tone="amber" icon="pencil-square">Unsaved changes</Badge>{/if}</span
        >
      {:else}
        {#if markdown && viewer.file && !viewer.file.binary}
          <SegmentedChoice
            label="Markdown view"
            options={[
              { value: "rendered", label: "Rendered" },
              { value: "source", label: "Source" },
            ]}
            bind:value={() => mode, (value) => devicePreferences.set("attachmentMarkdown", value)}
          />
        {/if}
        {#if viewer.file && !viewer.file.binary}<Button
            size="sm"
            variant="secondary"
            disabled={!viewer.editable || viewer.loading}
            onclick={() => viewer.edit()}>Edit</Button
          >{/if}
        <Button size="sm" variant="ghost" disabled={viewer.loading} onclick={() => void viewer.load()}>Reload</Button>
      {/if}
      <span class="grow"></span>
      {#if target.local && viewer.file}<Button
          size="sm"
          variant="ghost"
          onclick={() => void openInApp({ ...target, path: viewer.path })}>Open in default app</Button
        >{/if}
      <span class="inline-flex size-8 items-center justify-center"
        ><CopyButton text={viewer.path || target.path} label="Copy path" /></span
      >
      <Button
        size="sm"
        variant="ghost"
        disabled={!viewer.file?.sha256 || viewer.loading || viewer.busy || viewer.editing}
        onclick={() => (confirmDelete = true)}>Delete file</Button
      >
    </div>

    {#if viewer.error}
      <Alert tone="error">{viewer.error}</Alert>
      {#if viewer.conflict}
        <div>
          <Button size="sm" onclick={() => void viewer.load().then(() => viewer.discard())}>Discard and reload</Button>
        </div>
      {/if}
    {/if}
    {#if !viewer.loading && !viewer.error && !viewer.file && viewer.lookup}
      <FileLookup file={viewer.lookup} path={target.path} onselect={(path) => void viewer.load(path)} />
    {/if}
    {#if viewer.file && !viewer.editable && !viewer.editing && !viewer.file.binary}
      <p class="text-sm/5 text-muted">
        {viewer.file.truncated
          ? `Showing the first 2 MB.${target.local ? " Open the file in its default app to see all of it." : ""}`
          : `Files over ${formatSize(EDIT_LIMIT_BYTES)} open read-only.`}
      </p>
    {/if}

    {#if viewer.loading || viewer.file}<div
        class="max-h-[65dvh] min-w-0 overflow-auto overscroll-contain rounded-lg bg-zinc-950/3 dark:bg-white/5"
      >
        {#if viewer.editing}
          <CodeEditor
            text={viewer.text}
            fileName={name}
            wrap={markdown}
            onchange={(text) => (viewer.draft = text)}
            onsave={save}
          />
        {:else}
          <FileContentView
            local={target.local}
            file={viewer.file}
            text={viewer.text}
            {name}
            loading={viewer.loading}
            rendered={markdown && mode === "rendered"}
          />
        {/if}
      </div>{/if}
  </div>
</Dialog>

<Dialog bind:open={confirmDelete} title="Delete file?" dismissible={!viewer.busy}>
  <p>
    Delete <code class="font-mono break-all">{viewer.lookup?.relativePath || name}</code> from {viewer.lookup
      ?.computer || "the thread’s computer"}. This cannot be undone.
  </p>
  <div class="mt-6 flex justify-end gap-2">
    <Button disabled={viewer.busy} onclick={() => (confirmDelete = false)}>Cancel</Button>
    <Button variant="danger" disabled={viewer.busy} onclick={remove}>Delete file</Button>
  </div>
</Dialog>

<Dialog bind:open={confirmClose} title="Discard unsaved changes?">
  <p>Your edits to <code class="font-mono break-all">{name}</code> are not saved.</p>
  <div class="mt-6 flex justify-end gap-2">
    <Button onclick={() => (confirmClose = false)}>Keep editing</Button>
    <Button
      variant="danger"
      onclick={() => {
        viewer.discard();
        confirmClose = false;
        close();
      }}>Discard changes</Button
    >
  </div>
</Dialog>
