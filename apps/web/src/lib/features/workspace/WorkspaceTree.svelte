<script lang="ts">
  import { tick, untrack } from "svelte";
  import { createSubscriber } from "svelte/reactivity";
  import { ThreadDirectoryKind as Kind } from "@canopy/contracts";
  import type { Workspace } from "@canopy/domain/workspace";
  import { workspaceDirectories, type DirectoryRow } from "@canopy/domain/workspace-directory";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import WorkspaceTreeRow from "./WorkspaceTreeRow.svelte";
  import WorkspaceTreeSkeleton from "./WorkspaceTreeSkeleton.svelte";
  import { workspaceVersion } from "./workspace.svelte.ts";

  let { view, root, onopen }: { view: Workspace; root: string; onopen: () => void } = $props();
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

  // Root reading with nothing listed yet: placeholder rows stand where the first page will appear.
  const opening = $derived.by(() => {
    subscribe();
    tree.getVersion();
    const root = tree.node("");

    return Boolean(root.read) && !root.entries.length;
  });

  const refreshing = $derived.by(() => {
    subscribe();
    tree.getVersion();
    const root = tree.node("");

    return Boolean(root.read) && root.entries.length > 0;
  });

  // Git and live-update states share one pill over the bottom of the list; rows never move for it.
  const status = $derived.by(() => {
    subscribe();
    tree.getVersion();

    return error ?? (tree.watchStatus || tree.node("").status);
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

  /** A directory row spins while its listed entries refresh; a first read shows on its placeholder row instead. */
  function reading(row: DirectoryRow) {
    const path = row.kind === "entry" ? row.entry.path : row.directory;
    const node = row.kind === "entry" ? tree.nodes.get(path) : tree.node(path);

    return Boolean(node?.read) && (row.kind !== "entry" || (tree.expanded.has(path) && node!.entries.length > 0));
  }
</script>

<svelte:document onvisibilitychange={() => (foreground = !globalThis.document.hidden)} />

<div class="density-chrome relative flex h-full min-h-60 min-w-0 flex-col" aria-label="Files">
  <span class="pointer-events-none invisible absolute h-8 pointer-coarse:h-12" bind:clientHeight={rowHeight}></span>
  <!-- The 48px strip lines up with the thread's top bar and keeps clear of the window controls. -->
  <div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-divider pr-2 pl-3" data-window-end>
    <p class="flex min-w-0 items-baseline gap-1.5 text-sm">
      <span class="shrink-0 font-medium">Files</span>
      {#if root}<span class="truncate text-muted" title={root}>{root}</span>{/if}
    </p>
    <div class="flex shrink-0 items-center gap-1">
      <span class="flex size-4 items-center justify-center" aria-hidden="true"
        >{#if refreshing}<Spinner class="size-3.5 text-muted" />{/if}</span
      >
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
  <div
    bind:this={scroller}
    bind:clientHeight={height}
    role="tree"
    aria-label="Working directory"
    class="min-h-0 flex-1 overflow-auto pt-1"
    onscroll={() => {
      top = scroller?.scrollTop ?? 0;
    }}
  >
    <div style:height={`${rows.length * rowHeight + (status ? 48 : 8)}px`} class="relative min-w-0">
      {#if opening}
        <WorkspaceTreeSkeleton {rowHeight} />
      {:else}
        {#each visible as { row, index } (row.key)}
          {@const node = row.kind !== "entry" ? tree.node(row.directory) : undefined}
          <WorkspaceTreeRow
            {row}
            {index}
            height={rowHeight}
            expanded={row.kind === "entry" && tree.expanded.has(row.entry.path)}
            reading={reading(row)}
            selected={row.kind === "entry" && selected === row.entry.path}
            tabbable={row.key === focused || (!rows.some((entry) => entry.key === focused) && row === rows[0])}
            state={{ error: node?.error ?? "", empty: Boolean(node?.complete && !node.entries.length) }}
            onopen={() => open(row)}
            onkeep={() => {
              open(row);
              view.keep(view.active);
            }}
            onkeydown={(event) => keydown(event, row)}
            onfocus={() => (focused = row.key)}
          />
        {/each}
      {/if}
    </div>
  </div>
  {#if status}<p
      role={error ? "alert" : "status"}
      class={[
        "t-rise absolute inset-x-2 bottom-2 rounded-md border border-divider bg-surface px-2.5 py-1.5 text-xs shadow-sm",
        error ? "text-rose-700 dark:text-rose-400" : "text-muted",
      ]}
    >
      {status}
    </p>{/if}
</div>
