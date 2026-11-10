<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { visibleCopyTree, toggleCopyNode, copySize, type CopyTreeNode } from "@canopy/domain/workspace-copy";
  import ChoiceControl from "./ChoiceControl.svelte";
  import Icon from "./Icon.svelte";
  import SearchField from "./SearchField.svelte";

  let {
    roots,
    selected,
    onchange,
    class: className,
  }: {
    roots: CopyTreeNode[];
    selected: ReadonlySet<string>;
    onchange: (selected: Set<string>) => void;
    class?: ClassValue;
  } = $props();

  let expanded = $state.raw(new Set<string>(["files:"]));
  let query = $state("");
  let scroll = $state(0);
  let height = $state(280);
  let rowHeight = $state(28);
  let viewport = $state<HTMLDivElement>();
  let focused = $state(0);
  const rows = $derived(visibleCopyTree(roots, expanded, query));
  const start = $derived(Math.max(0, Math.floor(scroll / rowHeight) - 5));
  const end = $derived(Math.min(rows.length, start + Math.ceil(height / rowHeight) + 10));

  $effect(() => {
    const max = Math.max(0, rows.length * rowHeight - height);

    if (viewport && scroll > max) viewport.scrollTop = max;
  });

  onMount(() => {
    const media = matchMedia("(max-width: 639px), (pointer: coarse)");

    const resize = () => {
      rowHeight = media.matches ? 44 : 28;
    };

    resize();
    media.addEventListener("change", resize);

    return () => media.removeEventListener("change", resize);
  });

  function expand(node: CopyTreeNode) {
    const next = new Set(expanded);

    if (next.has(node.key)) next.delete(node.key);
    else next.add(node.key);
    expanded = next;
  }

  async function move(index: number) {
    focused = Math.max(0, Math.min(rows.length - 1, index));

    if (viewport) viewport.scrollTop = Math.max(0, focused * rowHeight - height / 2);
    await tick();
    viewport?.querySelector<HTMLElement>(`[data-row="${focused}"]`)?.focus();
  }

  function keys(event: KeyboardEvent, node: CopyTreeNode, index: number) {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", " ", "Home", "End"].includes(event.key)) return;
    event.preventDefault();

    if (event.key === "ArrowDown") void move(index + 1);

    if (event.key === "ArrowUp") void move(index - 1);

    if (event.key === "Home") void move(0);

    if (event.key === "End") void move(rows.length - 1);

    if (event.key === " " && !node.blocked) onchange(toggleCopyNode(selected, node));

    if (event.key === "ArrowRight" && node.children.length && !expanded.has(node.key)) expand(node);

    if (event.key === "ArrowLeft" && expanded.has(node.key)) expand(node);
  }
</script>

<div class={["flex min-h-0 flex-col gap-2", className]}>
  <SearchField
    name="copy-file-filter"
    label="Filter files"
    placeholder="Filter files…"
    bind:value={query}
    oninput={() => {
      if (viewport) viewport.scrollTop = 0;
      focused = 0;
    }}
  />
  <div
    bind:this={viewport}
    bind:clientHeight={height}
    onscroll={(e) => (scroll = e.currentTarget.scrollTop)}
    class="h-72 min-h-36 scroll-stable overflow-auto overscroll-contain rounded-lg border border-zinc-950/10 dark:border-white/10"
    role="tree"
    aria-label="Files to copy"
    aria-multiselectable="true"
  >
    <div class="relative h-(--tree-height)" style:--tree-height="{rows.length * rowHeight}px">
      {#each rows.slice(start, end) as node, local (node.key)}
        {@const index = start + local}
        {@const count = node.members.reduce((sum, path) => sum + Number(selected.has(path)), 0)}
        <div
          role="treeitem"
          tabindex={focused === index ? 0 : -1}
          data-row={index}
          aria-level={node.depth + 1}
          aria-selected={count > 0}
          aria-expanded={node.children.length ? expanded.has(node.key) : undefined}
          onfocus={() => (focused = index)}
          onkeydown={(e) => keys(e, node, index)}
          class="absolute inset-x-0 top-(--row-top) flex h-(--row-height) items-center gap-2 pr-2 pl-(--indent) text-base/6 text-zinc-950 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 sm:text-sm/5 dark:text-white"
          style:--row-top="{index * rowHeight}px"
          style:--row-height="{rowHeight}px"
          style:--indent="{8 + Math.min(node.depth, 8) * 14}px"
        >
          <button
            type="button"
            tabindex="-1"
            aria-label="{expanded.has(node.key) ? 'Collapse' : 'Expand'} {node.label}"
            disabled={!node.children.length}
            onclick={() => expand(node)}
            class="flex size-5 shrink-0 items-center justify-center disabled:invisible"
          >
            <Icon name={expanded.has(node.key) ? "chevron-down" : "chevron-right"} />
          </button>
          <ChoiceControl
            type="checkbox"
            tabindex={-1}
            name="copy-file"
            aria-label="Copy {node.path || node.label}"
            checked={count > 0 && count === node.members.length}
            indeterminate={count > 0 && count < node.members.length}
            disabled={Boolean(node.blocked) || !node.members.length}
            onchange={() => onchange(toggleCopyNode(selected, node))}
          />
          <div class="min-w-0 flex-1 truncate" title={node.blocked || node.path || node.label}>
            {node.label}{node.children.length ? ` (${node.files.toLocaleString()})` : ""}
          </div>
          <div class="shrink-0 text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
            {#if node.blocked}Unavailable{:else if node.secret}<span title="May contain secrets">Secrets?</span>{/if}
          </div>
          <div
            class="w-16 shrink-0 text-right text-sm text-zinc-500 tabular-nums sm:text-xs dark:text-zinc-400"
            title="{node.files} files"
          >
            {copySize(node.bytes)}
          </div>
        </div>
      {/each}
    </div>
    {#if !rows.length}<p class="p-3 text-sm text-zinc-500">No matching files</p>{/if}
  </div>
</div>
