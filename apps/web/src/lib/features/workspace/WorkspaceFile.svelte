<script module lang="ts">
  // One import for every file tab: a reader that is already loaded mounts in the same frame as its text.
  let loadedReader: typeof import("./WorkspaceSource.svelte").default | undefined;

  const reader = import("./WorkspaceSource.svelte").then((module) => (loadedReader = module.default));
</script>

<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import WorkspaceFileToolbar from "./WorkspaceFileToolbar.svelte";
  import type { WorkspaceFile } from "@canopy/domain/workspace-file";
  import { observeWorkspaceFile } from "@canopy/domain/workspace-changes";
  import { fileName } from "@canopy/domain/file-references";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import CodeEditor from "#lib/features/files/CodeEditor.svelte";
  import FileContentView from "#lib/features/files/FileContentView.svelte";
  import FileLookup from "#lib/features/files/FileLookup.svelte";
  import { workspaceVersion, workspaceStore } from "./workspace.svelte.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import { contributeCommands } from "#lib/features/commands/commands.svelte.ts";
  import { editorMemory, forgetEditor } from "./editor-memory.ts";
  import { confineSelectAll } from "#lib/shared/ui/select-all.ts";
  import Delayed from "#lib/shared/ui/Delayed.svelte";
  import FileSkeleton from "./FileSkeleton.svelte";
  import type { FileNotice } from "./file-notice.ts";

  let {
    document,
    onclose,
    onkeep,
    preview,
    tabActions,
  }: {
    document: WorkspaceFile;
    onclose: () => void;
    onkeep: () => void;
    preview: boolean;
    /** Tab management for the file's ⋯ menu (move, close others). */
    tabActions?: Snippet;
  } = $props();

  let scroller = $state<HTMLDivElement>();
  let confirmation = $state<"discard" | "delete" | undefined>();
  let goOpen = $state(false);
  let line = $state("");
  let rendered = $state(false);
  let foreground = $state(!globalThis.document.hidden);
  let compare = $state<"disk" | "draft" | undefined>();
  const name = $derived(fileName(document.path));
  let Reader = $state(loadedReader);
  let sourceNotice = $state<FileNotice>();
  let highlight = $state(false);

  // A tab that opens on text it already has shows it at once; text that arrives later fades in.
  const fade = untrack(() => !document.file);

  if (!loadedReader) void reader.then((value) => (Reader = value));

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
      changedOnDisk: document.changedOnDisk,
      removedOnDisk: document.removedOnDisk,
      diskText: document.diskText,
      watchStatus: document.watchStatus,
    };
  });

  const watchPath = $derived(viewer.file?.relativePath);

  const notice = $derived.by((): FileNotice | undefined => {
    const position = viewer.position;

    if (viewer.file && position && position.line > viewer.text.split("\n").length)
      return {
        text: "Line outside the preview",
        detail: "This line is outside the preview. Choose a visible line.",
        action: { label: "Go to line", run: () => (goOpen = true) },
      };

    if (viewer.file?.truncated)
      return { text: "Showing the first 2 MB", detail: "Showing the first 2 MB. This file is read only." };

    if (viewer.editing) return viewer.dirty ? { text: "Unsaved changes" } : undefined;

    if (viewer.watchStatus) return { text: viewer.watchStatus };

    return sourceNotice;
  });

  $effect(() => {
    void watchPath;

    if (foreground && watchPath) return observeWorkspaceFile(workspaceStore, document);
  });

  $effect(() => {
    if (!viewer.changedOnDisk) compare = undefined;
  });

  $effect(() => {
    const current = document;

    if (!foreground) return;
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
      disabled: !viewer.dirty || viewer.busy || viewer.changedOnDisk,
      run: () => void document.save(),
    },
  ]);

  function discard() {
    if (document.dirty) confirmation = "discard";
    else document.discard();
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
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

<svelte:document onvisibilitychange={() => (foreground = !globalThis.document.hidden)} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex min-h-0 flex-1 flex-col" onkeydowncapture={keydown}>
  <WorkspaceFileToolbar
    {document}
    {preview}
    markdown={/\.(md|markdown|mdx)$/i.test(name) && !viewer.file?.binary}
    bind:rendered
    state={{
      path: viewer.file?.relativePath || document.path,
      editing: viewer.editing,
      dirty: viewer.dirty,
      busy: viewer.busy,
      loading: viewer.loading,
      editable: viewer.editable,
      text: viewer.file && !viewer.file.binary ? viewer.text : undefined,
      sha256: viewer.file?.sha256,
      changedOnDisk: viewer.changedOnDisk,
    }}
    {notice}
    {onkeep}
    ongoline={() => (goOpen = true)}
    ondelete={() => (confirmation = "delete")}
    ondiscard={discard}
    {tabActions}
  />
  {#if viewer.error}<Alert tone="error" banner>{viewer.error}</Alert>{/if}
  {#if viewer.changedOnDisk}
    <div class="flex flex-wrap items-center gap-2 border-b border-divider bg-surface px-3 py-2" role="status">
      <span class="text-sm text-muted">{viewer.removedOnDisk ? "Removed from disk" : "Changed on disk"}</span>
      {#if viewer.diskText !== undefined && viewer.dirty}<Button
          size="sm"
          onclick={() => (compare = compare ? undefined : "disk")}
          >{compare ? "Keep editing" : "Compare changes"}</Button
        >{/if}
      {#if viewer.dirty}<CopyButton text={viewer.draft} label="Copy changes" />{/if}
      <Button
        size="sm"
        disabled={viewer.busy}
        onclick={() => {
          if (viewer.dirty) confirmation = "discard";
          else {
            document.discard();
            void document.load();
          }
        }}>Discard and reload</Button
      >
    </div>
  {/if}
  {#if compare}
    <div class="flex items-center gap-2 border-b border-divider bg-surface px-3 py-2">
      <Button size="sm" variant={compare === "disk" ? "primary" : "ghost"} onclick={() => (compare = "disk")}
        >On disk</Button
      >
      <Button size="sm" variant={compare === "draft" ? "primary" : "ghost"} onclick={() => (compare = "draft")}
        >Your changes</Button
      >
    </div>
  {/if}
  <div
    bind:this={scroller}
    class="min-h-0 flex-1 overflow-auto overscroll-contain"
    onscroll={() => {
      if (scroller) document.scroll = scroller.scrollTop;
    }}
  >
    <div class={["h-full", fade && viewer.file && "t-rise"]}>
      {#if !foreground}
        <div class="h-full"></div>
      {:else if compare}
        {#if Reader}<Reader
            {document}
            text={compare === "disk" ? (viewer.diskText ?? "") : viewer.draft}
            path={name}
            revision={-1}
          />{/if}
      {:else if viewer.editing}
        <CodeEditor
          memory={editorMemory(document)}
          position={viewer.position}
          positionRevision={viewer.positionRevision}
          text={viewer.draft}
          fileName={name}
          wrap={false}
          onchange={(text) => document.setDraft(text)}
        />
      {:else if !viewer.file && viewer.lookup && !viewer.loading}
        <FileLookup file={viewer.lookup} path={document.path} onselect={(path) => void document.load(path)} />
      {:else if !viewer.file && viewer.loading}
        <Delayed><FileSkeleton /></Delayed>
      {:else if viewer.file && !viewer.file.binary && !rendered}
        {#if Reader}<Reader
            {document}
            text={viewer.text}
            path={viewer.file.relativePath || document.path}
            revision={viewer.positionRevision}
            bind:highlight
            onnotice={(value) => (sourceNotice = value)}
          />{/if}
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
          const reload = document.changedOnDisk;
          document.discard();
          if (reload) void document.load();
          compare = undefined;
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
