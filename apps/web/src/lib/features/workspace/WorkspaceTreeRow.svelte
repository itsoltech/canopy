<script lang="ts">
  import { ThreadDirectoryKind as Kind, type ThreadDirectoryEntry } from "@canopy/contracts";
  import type { DirectoryRow } from "@canopy/domain/workspace-directory";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  /**
   * One row of the virtual file tree at a fixed height and offset. Every row keeps a chevron slot, so names line up
   * at each depth, and a directory that is reading shows a spinner in that slot instead of adding a row.
   */
  let {
    row,
    index,
    height,
    expanded,
    reading,
    selected,
    tabbable,
    state,
    onopen,
    onkeep,
    onkeydown,
    onfocus,
  }: {
    row: DirectoryRow;
    index: number;
    height: number;
    expanded: boolean;
    /** This directory (or the directory of a state row) is reading a page. */
    reading: boolean;
    selected: boolean;
    tabbable: boolean;
    /** For `more` and `state` rows: the directory's error, or whether it has no entries. */
    state: { error: string; empty: boolean };
    onopen: () => void;
    onkeep: () => void;
    onkeydown: (event: KeyboardEvent) => void;
    onfocus: () => void;
  } = $props();

  const entry: ThreadDirectoryEntry | undefined = $derived(row.kind === "entry" ? row.entry : undefined);
  const directory = $derived(entry?.kind === Kind.DIRECTORY);
  const status = $derived(entry?.gitStatus ?? "");
  const pending = $derived(row.kind === "state" && reading);

  const statusLabel = (value: string) =>
    ({ M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Conflict", "?": "Untracked", "!": "Ignored" })[
      value
    ] ?? "";

  const label = $derived(
    entry?.name ??
      (pending ? "Loading files…" : state.error ? "Reload directory" : state.empty ? "Empty directory" : "Load more"),
  );
</script>

<button
  type="button"
  role="treeitem"
  aria-level={row.depth + 1}
  aria-expanded={directory ? expanded : undefined}
  aria-selected={entry ? selected : undefined}
  aria-busy={reading || undefined}
  aria-disabled={entry ? entry.kind === Kind.SYMLINK || entry.kind === Kind.DELETED : pending}
  aria-label={entry
    ? `${entry.path}${status ? `, ${statusLabel(status)}` : ""}${entry.kind === Kind.SYMLINK ? ", Symbolic link" : ""}`
    : label}
  tabindex={tabbable ? 0 : -1}
  data-tree-key={row.key}
  title={entry?.path ?? (state.error || undefined)}
  style:height={`${height}px`}
  style:top={`${index * height}px`}
  style:padding-left={`${row.depth * 16 + 6}px`}
  class={[
    "group absolute inset-x-1 flex min-w-0 items-center gap-1 rounded-md pr-2 text-left text-sm focus-ring focus-visible:-outline-offset-2",
    selected ? "bg-zinc-950/6 dark:bg-white/10" : "hover:bg-zinc-950/4 dark:hover:bg-white/6",
    (status === "M" || status === "R") && "text-amber-700 dark:text-amber-400",
    (status === "A" || status === "?") && "text-emerald-700 dark:text-emerald-400",
    (status === "D" || status === "U") && "text-rose-700 dark:text-rose-400",
    (status === "!" || !entry) && "text-muted",
    entry?.kind === Kind.DELETED && "line-through",
  ]}
  {onkeydown}
  {onfocus}
  onclick={() => {
    if (!pending) onopen();
  }}
  ondblclick={() => {
    if (entry?.kind === Kind.FILE) onkeep();
  }}
>
  {#each { length: row.depth }, depth (depth)}
    <span
      aria-hidden="true"
      class="pointer-events-none absolute inset-y-0 w-px bg-zinc-950/8 dark:bg-white/8"
      style:left={`${depth * 16 + 13.5}px`}
    ></span>
  {/each}
  <span class="flex size-4 shrink-0 items-center justify-center">
    {#if reading && (directory || pending)}<Spinner class="size-3.5 text-muted" />{:else if directory}<Icon
        name={expanded ? "chevron-down" : "chevron-right"}
        size="sm"
      />{/if}
  </span>
  {#if pending}
    <Skeleton class="h-2.5 w-24" />
    <span class="sr-only">{label}</span>
  {:else}
    <Icon
      name={directory
        ? expanded
          ? "folder-open"
          : "folder"
        : entry?.kind === Kind.SYMLINK
          ? "link"
          : entry
            ? "document-text"
            : state.error
              ? "arrow-path"
              : "ellipsis-horizontal"}
    />
    <span class="min-w-0 flex-1 truncate">{label}</span>
  {/if}
  <span class="w-3 shrink-0 text-center text-xs" aria-hidden="true">{status}</span>
</button>
