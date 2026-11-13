<script lang="ts">
  import { tick, untrack } from "svelte";
  import { createSubscriber } from "svelte/reactivity";
  import { ThreadDirectoryKind as Kind } from "@canopy/contracts";
  import type { Workspace } from "@canopy/domain/workspace";
  import { workspaceDirectories, type DirectoryRow } from "@canopy/domain/workspace-directory";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import { workspaceVersion } from "./workspace.svelte.ts";

  let { view, onopen }: { view: Workspace; onopen: () => void } = $props();
  const tree = untrack(() => workspaceDirectories(view.store, 2 * 1024 * 1024).tree(view.threadId));
  const subscribe = createSubscriber((update) => tree.subscribe(update));

  const rows = $derived.by(() => {
    subscribe();
    tree.getVersion();

    return tree.rows();
  });

  const selected = $derived.by(() => {
    workspaceVersion();

    return view.currentFile?.document.path;
  });

  let scroller = $state<HTMLElement>();
  let height = $state(400);
  let rowHeight = $state(32);
  let top = $state(0);
  let focused = $state("");
  const first = $derived(Math.max(0, Math.floor(top / rowHeight) - 10));
  const count = $derived(Math.min(119, Math.ceil(height / rowHeight) + 20));

  const visible = $derived.by(() => {
    const entries = rows.slice(first, first + count).map((row, offset) => ({ row, index: first + offset }));
    const index = rows.findIndex((row) => row.key === focused);

    if (index >= 0 && (index < first || index >= first + count)) entries.push({ row: rows[index]!, index });

    return entries.sort((a, b) => a.index - b.index);
  });

  const error = $derived.by(() => {
    subscribe();
    tree.getVersion();

    return [...tree.nodes.values()].find((node) => node.error)?.error;
  });

  let previous: DirectoryRow[] = [];
  let foreground = $state(!globalThis.document.hidden);

  $effect(() => (foreground ? tree.retain() : undefined));

  $effect.pre(() => {
    const next = rows;
    untrack(() => {
      if (scroller && previous.length) {
        const index = Math.floor(scroller.scrollTop / rowHeight);
        const key = previous[index]?.key;
        const at = key ? next.findIndex((row) => row.key === key) : -1;

        if (at >= 0 && at !== index) {
          const position = scroller.scrollTop + (at - index) * rowHeight;
          void tick().then(() => {
            if (scroller) scroller.scrollTop = position;
          });
        }
      }

      previous = next;
    });
  });

  function open(row: DirectoryRow) {
    if (row.kind !== "entry") {
      void tree.load(row.directory, row.kind === "state");

      return;
    }

    if (row.entry.kind === Kind.DIRECTORY) tree.toggle(row.entry.path);
    else if (row.entry.kind === Kind.FILE) {
      view.open({ threadId: view.threadId, path: row.entry.path });
      onopen();
    }
  }

  async function focus(index: number) {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];

    if (!row || !scroller) return;
    focused = row.key;
    const at = rows.indexOf(row) * rowHeight;

    if (at < scroller.scrollTop) scroller.scrollTop = at;
    else if (at + rowHeight > scroller.scrollTop + height) scroller.scrollTop = at + rowHeight - height;
    top = scroller.scrollTop;
    await tick();
    scroller.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(row.key)}"]`)?.focus();
  }

  function keydown(event: KeyboardEvent, row: DirectoryRow) {
    const at = rows.indexOf(row);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      void focus(at + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      void focus(event.key === "Home" ? 0 : rows.length - 1);
    } else if (row.kind === "entry" && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();

      if (event.key === "ArrowRight" && row.entry.kind === Kind.DIRECTORY && !tree.expanded.has(row.entry.path))
        tree.toggle(row.entry.path);
      else if (event.key === "ArrowLeft" && tree.expanded.has(row.entry.path)) tree.toggle(row.entry.path);
      else if (event.key === "ArrowLeft")
        void focus(
          rows.findIndex(
            (entry) => entry.kind === "entry" && entry.entry.path === row.entry.path.split("/").slice(0, -1).join("/"),
          ),
        );
      else void focus(at + 1);
    }
  }

  const statusLabel = (status: string) =>
    ({ M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Conflict", "?": "Untracked", "!": "Ignored" })[
      status
    ] ?? "";
</script>

<svelte:document onvisibilitychange={() => (foreground = !globalThis.document.hidden)} />

<div class="relative flex h-full min-h-60 min-w-0 flex-col" aria-label="Files">
  <span class="pointer-events-none invisible absolute h-8 pointer-coarse:h-12" bind:clientHeight={rowHeight}></span>
  <div class="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-divider px-2">
    <span class="truncate text-sm font-medium">Working directory</span>
    <div class="flex shrink-0 gap-1">
      <IconButton icon="arrow-path" label="Reload files" onclick={() => tree.invalidate()} />
      <DropdownMenu label="File tree options" placement="bottom-end">
        {#snippet trigger(props)}<IconButton
            icon="ellipsis-horizontal"
            label="File tree options"
            {...props}
          />{/snippet}
        <MenuCheckItem
          type="checkbox"
          checked={tree.includeIgnored}
          onselect={() => tree.showIgnored(!tree.includeIgnored)}>Show ignored files</MenuCheckItem
        >
      </DropdownMenu>
    </div>
  </div>
  {#if (subscribe(), tree.node("").status)}<p class="px-2 py-1 text-xs text-muted">{tree.node("").status}</p>{/if}
  {#if (subscribe(), tree.watchStatus)}<p role="status" class="px-2 py-1 text-xs text-muted">{tree.watchStatus}</p>{/if}
  <div
    bind:this={scroller}
    bind:clientHeight={height}
    role="tree"
    aria-label="Working directory"
    class="min-h-0 flex-1 overflow-auto"
    onscroll={() => {
      top = scroller?.scrollTop ?? 0;
    }}
  >
    <div style:height={`${rows.length * rowHeight}px`} class="relative min-w-0">
      {#each visible as { row, index } (row.key)}
        {@const entry = row.kind === "entry" ? row.entry : undefined}
        {@const node = row.kind !== "entry" ? tree.node(row.directory) : undefined}
        <button
          type="button"
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={entry?.kind === Kind.DIRECTORY ? tree.expanded.has(entry.path) : undefined}
          aria-selected={entry ? selected === entry.path : undefined}
          aria-disabled={entry ? entry.kind === Kind.SYMLINK || entry.kind === Kind.DELETED : !!node?.read}
          aria-label={entry
            ? `${entry.path}${entry.gitStatus ? `, ${statusLabel(entry.gitStatus)}` : ""}${entry.kind === Kind.SYMLINK ? ", Symbolic link" : ""}`
            : undefined}
          tabindex={row.key === focused || (!rows.some((entry) => entry.key === focused) && row === rows[0]) ? 0 : -1}
          data-tree-key={row.key}
          title={entry?.path ?? node?.error}
          style:height={`${rowHeight}px`}
          style:top={`${index * rowHeight}px`}
          style:padding-left={`${row.depth * 16 + 8}px`}
          class={[
            "absolute inset-x-0 flex w-full min-w-0 items-center gap-1.5 pr-2 text-left text-sm focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/10",
            !!entry && selected === entry.path && "bg-zinc-950/5 dark:bg-white/10",
            (entry?.gitStatus === "M" || entry?.gitStatus === "R") && "text-amber-700 dark:text-amber-400",
            (entry?.gitStatus === "A" || entry?.gitStatus === "?") && "text-emerald-700 dark:text-emerald-400",
            (entry?.gitStatus === "D" || entry?.gitStatus === "U") && "text-rose-700 dark:text-rose-400",
            entry?.gitStatus === "!" && "text-muted",
          ]}
          onkeydown={(event) => keydown(event, row)}
          onfocus={() => (focused = row.key)}
          onclick={() => {
            if (!node?.read) open(row);
          }}
          ondblclick={() => {
            if (entry?.kind === Kind.FILE) {
              open(row);
              view.keep(view.active);
            }
          }}
        >
          <Icon
            name={entry?.kind === Kind.DIRECTORY
              ? tree.expanded.has(entry.path)
                ? "chevron-down"
                : "chevron-right"
              : entry?.kind === Kind.SYMLINK
                ? "link"
                : entry
                  ? "document-text"
                  : "ellipsis-horizontal"}
          />
          <span class="min-w-0 flex-1 truncate"
            >{entry?.name ??
              (node?.read
                ? "Loading files…"
                : node?.error
                  ? "Reload directory"
                  : node?.complete
                    ? "Empty directory"
                    : "Load more")}</span
          >
          {#if entry?.gitStatus}<span class="shrink-0 text-xs" aria-hidden="true">{entry.gitStatus}</span>{/if}
        </button>
      {/each}
    </div>
  </div>
  {#if error}<p
      role="alert"
      class="shrink-0 border-t border-divider px-2 py-2 text-sm text-rose-600 dark:text-rose-400"
    >
      {error}
    </p>{/if}
</div>
