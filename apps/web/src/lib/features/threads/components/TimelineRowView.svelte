<script lang="ts">
  import { useThreadDirectory } from "../thread-directory.ts";
  import type { TimelineRow } from "../timeline.ts";
  import ItemNodeView from "./items/ItemNodeView.svelte";
  import UserMessageView from "./items/UserMessageView.svelte";
  import { STEERED } from "./message-notes.ts";
  import NoticeRow from "./NoticeRow.svelte";
  import TurnEnd from "./TurnEnd.svelte";
  import TurnInput from "./TurnInput.svelte";
  import TurnStart from "./TurnStart.svelte";

  /**
   * One row of a thread's timeline: a turn's start, input or end, an item (with nested items; a message
   * steered into the turn as such), a notice.
   */
  let { row }: { row: TimelineRow } = $props();
  const directory = useThreadDirectory();
  // A steered message with quotes got them as a platform note: show its own text and the quotes instead.
  const steer = $derived(row.kind === "item" && row.steer && row.node.entry.item.content.case === "userMessage" ? directory.steer?.(row.node.entry.item.content.value.clientId) : undefined);
</script>

{#if row.kind === "turn-start"}
  <TurnStart turn={row.turn} newDay={row.newDay} number={row.number} />
{:else if row.kind === "input"}
  <TurnInput turn={row.turn} text={row.turn.inputText} />
{:else if row.kind === "item" && row.inputOf && row.node.entry.item.content.case === "userMessage"}
  <TurnInput turn={row.inputOf} text={row.node.entry.item.content.value.text} attachments={row.node.entry.item.content.value.attachments} />
{:else if row.kind === "item" && row.steer && row.node.entry.item.content.case === "userMessage"}
  {@const message = row.node.entry.item.content.value}
  <!-- An agent's steer: its own text (the agent got it after a platform note naming the sender) and who sent it. -->
  <UserMessageView
    message={steer?.quotes.length || steer?.sender ? { ...message, text: steer.text } : message}
    quotes={steer?.quotes ?? []}
    note={STEERED}
    sender={steer?.sender}
  />
{:else if row.kind === "item"}
  <ItemNodeView node={row.node} />
{:else if row.kind === "notice"}
  <NoticeRow notice={row.notice} />
{:else}
  <TurnEnd turn={row.turn} result={row.result} answer={row.answer} />
{/if}
