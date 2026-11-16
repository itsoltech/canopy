<script lang="ts">
  import type { Snippet } from "svelte";
  import type { WorkspaceFile } from "@canopy/domain/workspace-file";
  import Button from "#lib/shared/ui/Button.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import { copyText } from "#lib/shared/clipboard.ts";
  import { openInApp } from "#lib/features/files/file-links.svelte.ts";
  import FileNoticePill from "./FileNoticePill.svelte";
  import type { FileNotice } from "./file-notice.ts";

  /**
   * One row above a file: its path, Source/Rendered for Markdown, Save and one menu with everything else.
   * Discard is available for dirty files; destructive actions sit last, after a separator.
   * The bar is 40px for every file: the path holds the left edge, controls keep their order from the right edge,
   * and a notice is a pill between them, never a row above the text.
   */
  let {
    document,
    local,
    preview,
    markdown,
    rendered = $bindable(false),
    state,
    onkeep,
    ongoline,
    ondelete,
    ondiscard,
    tabActions,
    notice,
  }: {
    document: WorkspaceFile;
    /** The file is on the computer showing it (onThisComputer): its default app can open it here. */
    local: boolean;
    preview: boolean;
    markdown: boolean;
    rendered?: boolean;
    state: {
      path: string;
      dirty: boolean;
      busy: boolean;
      loading: boolean;
      editable: boolean;
      text: string | undefined;
      sha256: string | undefined;
      changedOnDisk: boolean;
    };
    onkeep: () => void;
    ongoline: () => void;
    ondelete: () => void;
    ondiscard: () => void;
    tabActions?: Snippet;
    notice?: FileNotice | undefined;
  } = $props();

  const slash = $derived(state.path.lastIndexOf("/"));
  const parent = $derived(slash >= 0 ? state.path.slice(0, slash + 1) : "");
  const leaf = $derived(state.path.slice(slash + 1));
</script>

<div class="@container flex h-10 shrink-0 items-center gap-2 border-b border-divider bg-surface pr-2 pl-3">
  <p class="min-w-20 flex-1 truncate font-mono text-sm sm:text-xs" title={document.path}>
    <span class="text-muted select-text">{parent}</span><span class="font-medium select-text">{leaf}</span>
  </p>
  {#if notice}<FileNoticePill {notice} />{/if}
  {#if markdown}
    <SegmentedChoice
      label="View"
      class="shrink-0"
      disabled={state.text === undefined}
      bind:value={() => (rendered ? "rendered" : "source"), (value) => (rendered = value === "rendered")}
      options={[
        { value: "source", label: "Source" },
        { value: "rendered", label: "Rendered" },
      ]}
    />
  {/if}
  {#if state.editable}
    <span class="hidden @md:contents">
      <Button
        size="sm"
        variant="primary"
        disabled={!state.dirty || state.busy || state.changedOnDisk}
        onclick={() => void document.save()}>Save file</Button
      >
    </span>
    <span class="contents @md:hidden">
      <IconButton
        icon="arrow-down-tray"
        label="Save file"
        disabled={!state.dirty || state.busy || state.changedOnDisk}
        onclick={() => void document.save()}
      />
    </span>
  {/if}
  <DropdownMenu label="File actions" placement="bottom-end">
    {#snippet trigger(props)}<IconButton icon="ellipsis-horizontal" label="File actions" {...props} />{/snippet}
    {#if preview}<MenuItem icon="star" onselect={onkeep}>Keep tab</MenuItem>{/if}
    {#if notice?.action}<MenuItem icon="sparkles" onselect={notice.action.run}>{notice.action.label}</MenuItem>{/if}
    <MenuItem
      icon="arrow-path"
      disabled={state.loading || state.busy || state.dirty}
      onselect={() => void document.load()}>Reload</MenuItem
    >
    {#if state.dirty}<MenuItem icon="arrow-uturn-left" onselect={ondiscard}>Discard changes</MenuItem>{/if}
    {#if state.text !== undefined}<MenuItem icon="bars-3" onselect={ongoline}>Go to line</MenuItem>{/if}
    <MenuSeparator />
    <MenuItem icon="copy" onselect={() => void copyText(document.path)}>Copy path</MenuItem>
    {#if state.text !== undefined}<MenuItem icon="document-duplicate" onselect={() => void copyText(state.text ?? "")}
        >Copy text</MenuItem
      >{/if}
    {#if local}<MenuItem
        icon="arrow-top-right-on-square"
        onselect={() => void openInApp({ ...document.target, path: document.path, local: true })}
        >Open in default app</MenuItem
      >{/if}
    {#if tabActions}<MenuSeparator />{@render tabActions()}{/if}
    <MenuSeparator />
    <MenuItem icon="trash" danger disabled={!state.sha256 || state.busy || state.dirty} onselect={ondelete}
      >Delete file</MenuItem
    >
  </DropdownMenu>
</div>
