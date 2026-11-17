<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { Workspace } from "@canopy/domain/workspace";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import DiffRow from "./DiffRow.svelte";
  import DiffReview from "./DiffReview.svelte";
  import { getDiffState } from "./diff-state.svelte.ts";
  import { diffPageTargets } from "./diff-pages.svelte.ts";
  import { DiffLayout } from "./diff-layout.ts";
  import type { DiffComment } from "./diff-drafts.svelte.ts";

  let {
    view,
    disabled = false,
    class: className,
  }: { view: Workspace; disabled?: boolean; class?: ClassValue } = $props();

  const diff = $derived(getDiffState(view));
  const layout = $derived(new DiffLayout(diff.files));
  let scroller = $state<HTMLDivElement>();
  let height = $state(500);
  let width = $state(500);
  let horizontalLeft = $state(0);
  let rowHeight = $state(28);
  let top = $state(0);
  let physicalTop = $state(0);
  const totalHeight = $derived(layout.rows * rowHeight + Math.max(0, height - rowHeight));
  const physicalHeight = $derived(Math.min(8_000_000, totalHeight));
  const ratio = $derived(Math.max(1, (totalHeight - height) / Math.max(1, physicalHeight - height)));
  const first = $derived(Math.max(0, Math.floor(top / rowHeight) - 8));
  const count = $derived(Math.min(120, Math.ceil(height / rowHeight) + 16));
  const rows = $derived(layout.window(first, count));
  const file = $derived(diff.files[layout.fileAt(Math.floor(top / rowHeight))]);
  const lineCount = $derived(diff.review.draft.comments.length);

  $effect(() => {
    const current = diff;

    untrack(() => current.ensure());
  });

  $effect(() => {
    const current = diff;

    return () => current.pages.pause();
  });

  $effect(() => {
    const current = diff;
    const snapshot = current.snapshotId;
    const targets = diffPageTargets(rows);

    if (snapshot) untrack(() => current.pages.window(snapshot, targets));
    else untrack(() => current.pages.pause());
  });

  $effect(() => {
    const element = scroller;
    const snapshot = diff.snapshotId;
    void layout;

    if (!element || !snapshot) return;
    untrack(() => {
      element.scrollTop = diff.scroll / ratio;
      physicalTop = element.scrollTop;
      top = physicalTop * ratio;
    });
  });

  $effect(() => {
    const target = diff.target;
    const element = scroller;
    const at = target && target.revision > diff.navigated ? layout.paths.get(target.path) : undefined;

    if (element && at !== undefined)
      untrack(() => {
        element.scrollTop = Math.ceil((at * rowHeight) / ratio);
        physicalTop = element.scrollTop;
        top = physicalTop * ratio;
        diff.scroll = top;

        if (target) diff.navigated = target.revision;
      });
  });

  $effect(() => {
    const path = file?.path;

    if (path) untrack(() => (diff.activePath = path));
  });

  function comment(path: string, side: DiffComment["side"], line: number, source: string) {
    if (
      !diff.review.draft.comments.some(
        (entry) =>
          entry.path === path && entry.side === side && entry.line === line && entry.snapshotId === diff.snapshotId,
      )
    )
      diff.review.add({ snapshotId: diff.snapshotId, path, side, line, source }, "");
    diff.review.open = true;
  }
</script>

<div class={["density-chrome flex h-full min-h-0 min-w-0 flex-col bg-surface", className]}>
  <span class="invisible absolute h-7 pointer-coarse:h-10" bind:clientHeight={rowHeight}></span>
  <div class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-divider px-3 py-1">
    <p class="min-w-0 flex-1 truncate text-base sm:text-sm" title={file?.path}>{file?.path ?? "Local changes"}</p>
    <Button size="sm" variant="ghost" onclick={() => (diff.review.open = true)}
      >Review{lineCount ? ` (${lineCount.toLocaleString()})` : ""}</Button
    >
    <IconButton
      icon="arrow-path"
      label="Refresh changes"
      size="sm"
      disabled={diff.loading}
      onclick={() => diff.refresh()}
    />
  </div>
  {#if diff.error}<Alert tone="error" banner>{diff.error}</Alert>{/if}
  {#if diff.pages.error}
    <Alert tone="error" banner
      >{diff.pages.error}
      {#snippet actions()}<Button size="sm" onclick={() => diff.pages.retry()}>Retry lines</Button>{/snippet}
    </Alert>
  {/if}
  {#if !diff.files.length}
    <div class="flex min-h-0 flex-1 items-center justify-center p-6 text-center" role="status">
      <div class="max-w-md space-y-2">
        <p class="text-base font-medium sm:text-sm">
          {diff.loading
            ? "Loading changes…"
            : diff.loaded && !diff.error
              ? "No local changes"
              : "Changes are unavailable"}
        </p>
        {#if diff.loaded && !diff.error}<p class="text-base text-muted sm:text-sm">
            Staged, unstaged and untracked changes appear here.
          </p>{/if}
      </div>
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={scroller}
      bind:clientHeight={height}
      bind:clientWidth={width}
      tabindex="0"
      role="region"
      aria-label="Local Git diff"
      class="min-h-0 min-w-0 flex-1 scroll-stable overflow-auto overscroll-contain font-mono text-base focus-ring select-text focus-visible:-outline-offset-2 sm:text-sm"
      onscroll={() => {
        physicalTop = scroller?.scrollTop ?? 0;
        horizontalLeft = scroller?.scrollLeft ?? 0;
        top = physicalTop * ratio;
        diff.scroll = top;
      }}
    >
      <div class="relative min-w-full" style:height={`${physicalHeight}px`}>
        {#each rows as row (row.index)}
          <div
            class={["absolute", row.offset === -1 ? "" : "min-w-full"]}
            style:left={`${row.offset === -1 ? horizontalLeft : 0}px`}
            style:width={row.offset === -1 ? `${width}px` : undefined}
            style:top={`${row.index * rowHeight - top + physicalTop}px`}
            style:height={`${rowHeight}px`}
          >
            <DiffRow
              file={row.file}
              offset={row.offset}
              line={diff.pages.line(row.file.path, row.offset)}
              oncomment={(side, line, source) => comment(row.file.path, side, line, source)}
            />
          </div>
        {/each}
      </div>
    </div>
  {/if}
  <DiffReview state={diff} {disabled} />
</div>
