<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { FeedRow } from "../feed.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import ThreadLink from "./items/ThreadLink.svelte";
  import UserMessageView from "./items/UserMessageView.svelte";
  import { steeringNote } from "./message-notes.ts";
  import TimelineRowView from "./TimelineRowView.svelte";
  import TurnInput from "./TurnInput.svelte";

  /**
   * One row of the thread page's feed. Rows space themselves (bottom padding, measured with the row);
   * the rows of a fork's inherited history share a well, folded under its header (`ontoggle`).
   */
  let { row, ontoggle }: { row: FeedRow; ontoggle: () => void } = $props();

  const directory = useThreadDirectory();
  const well = "bg-zinc-950/2.5 px-3 dark:bg-white/4";
  const heading = $derived.by(() => {
    if (row.kind !== "history-head") return "";
    if (row.threadIds.length > 1) return `History from ${row.threadIds.length} threads`;
    return `History from “${directory.thread(row.threadIds[0] ?? row.sourceId)?.title ?? "the source thread"}”`;
  });
</script>

{#if row.kind === "history-head"}
  <div class={[!row.open && "pb-3"]}>
    <div class={[well, row.open ? "rounded-t-xl" : "rounded-xl"]}>
      <button type="button" class="flex w-full min-w-0 items-start gap-2 rounded-md py-2.5 text-left text-base/6 focus-ring select-none sm:py-2 sm:text-sm/6" aria-expanded={row.open} onclick={ontoggle}>
        <span class="flex h-lh items-center"><Icon name="chevron-right" class={["fill-zinc-400 t-acc-chevron dark:fill-zinc-500", row.open && "rotate-90"]} /></span>
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <span class="flex min-w-0 items-center gap-2 text-zinc-700 dark:text-zinc-300">
            <Icon name="square-2-stack" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
            <span class="truncate">{heading}</span>
          </span>
          <span class="shrink-0 text-sm/6 text-zinc-500 tabular-nums sm:text-xs/6 dark:text-zinc-400">{row.turns} {row.turns === 1 ? "turn" : "turns"}</span>
        </span>
      </button>
    </div>
  </div>
{:else if row.kind === "history-part"}
  <div class={[well, "pt-2 pb-1"]}>
    <p class="flex items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <span class="shrink-0">From</span><ThreadLink threadId={row.threadId} fallback="an earlier thread" />
    </p>
  </div>
{:else if row.kind === "timeline" && row.history}
  <div class={[row.last && "pb-3"]}>
    <div class={[well, "pb-3", row.last && "rounded-b-xl"]}>
      <div class="opacity-90"><TimelineRowView row={row.row} /></div>
    </div>
  </div>
{:else if row.kind === "timeline"}
  <div class="pb-3"><TimelineRowView row={row.row} /></div>
{:else if row.kind === "forked"}
  <div class="flex items-center gap-3 pb-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    <span class="flex min-w-0 items-center gap-1.5"><span class="shrink-0">Forked from</span><ThreadLink threadId={row.sourceId} fallback="the source thread" /></span>
    <span class="h-px min-w-8 flex-1 bg-zinc-950/5 dark:bg-white/10"></span>
  </div>
{:else if row.kind === "working"}
  <p class="pb-3 text-base/6 sm:text-sm/6"><span class="shimmer inline-block py-1 font-medium">Working…</span></p>
{:else if row.kind === "steer"}
  <div class="pb-3"><UserMessageView message={{ text: row.steer.text, authorAgentId: row.steer.sourceThreadId, attachments: [] }} note={steeringNote(row.steer)} pending /></div>
{:else}
  <div class="pb-3"><TurnInput turn={row.turn} text={row.turn.inputText} queued fallback={row.fallback} /></div>
{/if}
