<script lang="ts">
  import type { TimelineRow } from "../timeline.ts";
  import ItemNodeView from "./items/ItemNodeView.svelte";
  import NoticeRow from "./NoticeRow.svelte";
  import TurnEnd from "./TurnEnd.svelte";
  import TurnInput from "./TurnInput.svelte";
  import TurnStart from "./TurnStart.svelte";

  /** One row of a thread's timeline: a turn's start, input or end, an item (with nested items), a notice. */
  let { row }: { row: TimelineRow } = $props();
</script>

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
