<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { WorkspaceFile } from "@canopy/domain/workspace-file";
  import { fileName } from "@canopy/domain/file-references";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import CodeEditor from "#lib/features/files/CodeEditor.svelte";
  import FileContentView from "#lib/features/files/FileContentView.svelte";
  import FileLookup from "#lib/features/files/FileLookup.svelte";
  import { openInApp } from "#lib/features/files/file-links.svelte.ts";
  import { workspaceVersion } from "./workspace.svelte.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import { contributeCommands } from "#lib/features/commands/commands.svelte.ts";
  import { editorMemory, forgetEditor } from "./editor-memory.ts";
  import { confineSelectAll } from "#lib/shared/ui/select-all.ts";

  let {
    document,
    onclose,
    onkeep,
    preview,
  }: { document: WorkspaceFile; onclose: () => void; onkeep: () => void; preview: boolean } = $props();

  let scroller = $state<HTMLDivElement>();
  let confirmation = $state<"discard" | "delete" | undefined>();
  let goOpen = $state(false);
  let line = $state("");
  let rendered = $state(false);
  const name = $derived(fileName(document.path));

  const viewer = $derived.by(() => {
    void workspaceVersion();

    return {
      file: document.file,
      lookup: document.lookup,
      text: document.text,
      draft: document.draft,
      editing: document.editing,
      dirty: document.dirty,
      loading: document.loading,
      busy: document.busy,
      error: document.error,
      editable: document.editable,
      position: document.position,
      positionRevision: document.positionRevision,
    };
  });

  $effect(() => {
    const current = document;
    untrack(() => {
      if (!current.file && !current.loading) void current.load();
    });

    return () => current.cancel();
  });

  $effect(() => {
    if (!viewer.editing) forgetEditor(document);
  });

  $effect(() => {
    const root = scroller;

    if (!root) return;
    root.scrollTop = untrack(() => document.scroll);
  });

  $effect(() => {
    const position = viewer.position;
    void viewer.positionRevision;

    if (
      !position ||
      !viewer.file ||
      viewer.loading ||
      viewer.editing ||
      rendered ||
      document.readerPositionRevision === viewer.positionRevision
    )
      return;
    void tick().then(() => {
      const row = scroller?.querySelector<HTMLElement>(`[data-file-line="${position.line}"]`);

      if (row && scroller) {
        scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
        document.readerPositionRevision = document.positionRevision;
      }
    });
  });

  contributeCommands(() => [
    { id: "workspace:locate", title: "Go to line", group: "actions", run: () => (goOpen = true) },
    {
      id: "workspace:save-file",
      title: "Save file",
      group: "actions",
      disabled: !viewer.dirty || viewer.busy,
      run: () => void document.save(),
    },
  ]);

  function discard() {
    if (document.dirty) confirmation = "discard";
    else document.discard();
  }

  function keydown(event: KeyboardEvent) {
    confineSelectAll(event);

    if (keybindings.matches(event, "file:go-line")) {
      event.preventDefault();
      event.stopPropagation();
      goOpen = true;
    }

    if (viewer.editing && keybindings.matches(event, "file:save")) {
      event.preventDefault();
      event.stopPropagation();
      void document.save();
    }
  }

  function locate() {
    const match = /^(\d+)(?:-(\d+))?$/.exec(line);
    const start = Number(match?.[1]);
    const end = Number(match?.[2] ?? start);

    if (!Number.isSafeInteger(start) || start < 1 || end < start || end > document.text.split("\n").length) return;
    rendered = false;
    document.locate({ line: start, end, column: 1 });
    goOpen = false;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex min-h-0 flex-1 flex-col" onkeydowncapture={keydown}>
  <div class="flex flex-wrap items-center gap-2 border-b border-divider bg-surface px-3 py-2">
    {#if viewer.editing}
      <Button size="sm" variant="primary" disabled={!viewer.dirty || viewer.busy} onclick={() => void document.save()}
        >Save file</Button
      >
      <Button size="sm" disabled={viewer.busy} onclick={discard}
        >{viewer.dirty ? "Discard changes" : "Stop editing"}</Button
      >
    {:else}
      <Button
        size="sm"
        disabled={!viewer.editable || viewer.loading}
        onclick={() => {
          onkeep();
          document.edit();
        }}>Edit</Button
      >
      <Button size="sm" variant="ghost" disabled={viewer.loading || viewer.busy} onclick={() => void document.load()}
        >Reload</Button
      >
      {#if preview}<Button size="sm" variant="ghost" onclick={onkeep}>Keep tab</Button>{/if}
    {/if}
    <span class="min-w-0 flex-1 truncate text-sm text-muted" title={document.path}
      >{viewer.file?.relativePath || document.path}</span
    >
    {#if !viewer.editing && viewer.file && !viewer.file.binary}
      {#if /\.(md|markdown|mdx)$/i.test(name)}<Button size="sm" variant="ghost" onclick={() => (rendered = !rendered)}
          >{rendered ? "View source" : "Render Markdown"}</Button
        >{/if}
      <Button size="sm" variant="ghost" onclick={() => (goOpen = true)}>Go to line</Button>
    {/if}
    <CopyButton text={document.path} label="Copy path" />
    {#if viewer.file && !viewer.file.binary}<CopyButton text={viewer.text} label="Copy text" />{/if}
    {#if document.target.local}<Button
        size="sm"
        variant="ghost"
        onclick={() => void openInApp({ ...document.target, path: document.path, local: true })}
        >Open in default app</Button
      >{/if}
    <Button
      size="sm"
      variant="ghost"
      disabled={!viewer.file?.sha256 || viewer.busy || viewer.editing}
      onclick={() => (confirmation = "delete")}>Delete file</Button
    >
  </div>
  {#if viewer.error}<Alert tone="error" banner>{viewer.error}</Alert>{/if}
  {#if viewer.editing}<p role="status" class="h-6 px-3 text-sm text-muted">
      {viewer.dirty ? "Unsaved changes" : ""}
    </p>{/if}
  {#if viewer.position && viewer.position.line > viewer.text.split("\n").length && viewer.file}<p
      class="px-3 py-1 text-sm text-muted"
    >
      This line is outside the preview. Choose a visible line.
    </p>{/if}
  {#if viewer.file?.truncated}<p class="px-3 py-1 text-sm text-muted">
      Showing the first 2 MB. This file is read only.
    </p>{/if}
  <div
    bind:this={scroller}
    class="min-h-0 flex-1 overflow-auto overscroll-contain"
    onscroll={() => {
      if (scroller) document.scroll = scroller.scrollTop;
    }}
  >
    {#if viewer.editing}
      <CodeEditor
        memory={editorMemory(document)}
        workspace
        position={viewer.position}
        positionRevision={viewer.positionRevision}
        text={viewer.draft}
        fileName={name}
        wrap={false}
        onchange={(text) => document.setDraft(text)}
        onsave={() => void document.save()}
      />
    {:else if !viewer.file && viewer.lookup && !viewer.loading}
      <FileLookup file={viewer.lookup} path={document.path} onselect={(path) => void document.load(path)} />
    {:else if viewer.file && !viewer.file.binary && !rendered}
      {#await import("./WorkspaceSource.svelte") then reader}
        <reader.default
          {document}
          text={viewer.text}
          path={viewer.file.relativePath || document.path}
          revision={viewer.positionRevision}
        />
      {/await}
    {:else}
      <FileContentView
        file={viewer.file}
        text={viewer.text}
        {name}
        loading={viewer.loading}
        {rendered}
        local={Boolean(document.target.local)}
        position={viewer.position}
      />
    {/if}
  </div>
</div>

<Dialog
  bind:open={
    () => Boolean(confirmation),
    (open) => {
      if (!open) confirmation = undefined;
    }
  }
  title={confirmation === "delete" ? "Delete file?" : "Discard unsaved changes?"}
  dismissible={!viewer.busy}
>
  <p>
    {confirmation === "delete"
      ? `Delete ${name} from ${viewer.lookup?.computer || "the thread’s computer"}. This cannot be undone.`
      : `Your edits to ${name} are not saved.`}
  </p>
  <div class="mt-6 flex justify-end gap-2">
    <Button disabled={viewer.busy} onclick={() => (confirmation = undefined)}>Cancel</Button>
    <Button
      variant="danger"
      disabled={viewer.busy}
      onclick={async () => {
        if (confirmation === "delete") {
          if (await document.remove()) {
            confirmation = undefined;
            onclose();
          }
        } else {
          document.discard();
          confirmation = undefined;
        }
      }}>{confirmation === "delete" ? "Delete file" : "Discard changes"}</Button
    >
  </div>
</Dialog>

<Dialog bind:open={goOpen} title="Go to line">
  <form
    class="flex gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      locate();
    }}
  >
    <Input name="line" aria-label="Line or range" placeholder="31 or 31-40" bind:value={line} data-autofocus />
    <Button type="submit" variant="primary">Go to line</Button>
  </form>
</Dialog>
