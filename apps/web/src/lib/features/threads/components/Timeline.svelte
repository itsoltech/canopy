<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { TimelineRow } from "../timeline.ts";
  import ItemNodeView from "./items/ItemNodeView.svelte";
  import NoticeRow from "./NoticeRow.svelte";
  import TurnEnd from "./TurnEnd.svelte";
  import TurnInput from "./TurnInput.svelte";
  import TurnStart from "./TurnStart.svelte";

  /** The rows of a thread, then queued inputs and, while a turn runs, a working indicator. */
  let { rows, queued = [], working = false }: { rows: readonly TimelineRow[]; queued?: readonly ui.Turn[]; working?: boolean } = $props();
</script>

<ol role="list" class="grid gap-3">
  {#each rows as row (row.key)}
    <li class="min-w-0">
      {#if row.kind === "turn-start"}
        <TurnStart turn={row.turn} />
      {:else if row.kind === "input"}
        <TurnInput turn={row.turn} text={row.turn.inputText} />
      {:else if row.kind === "item" && row.inputOf && row.node.entry.item.content.case === "userMessage"}
        <TurnInput turn={row.inputOf} text={row.node.entry.item.content.value.text} attachments={row.node.entry.item.content.value.attachments} />
      {:else if row.kind === "item"}
        <ItemNodeView node={row.node} />
      {:else if row.kind === "notice"}
        <NoticeRow notice={row.notice} />
      {:else}
        <TurnEnd turn={row.turn} result={row.result} />
      {/if}
    </li>
  {/each}
  {#if working}
    <li class="py-1 text-base/6 sm:text-sm/6"><span class="shimmer font-medium">Working…</span></li>
  {/if}
  {#each queued as turn (turn.id)}
    <li><TurnInput {turn} text={turn.inputText} queued /></li>
  {/each}
</ol>
