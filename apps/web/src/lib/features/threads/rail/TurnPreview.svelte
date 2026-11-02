<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import MarkdownSnippet from "#lib/shared/ui/markdown/MarkdownSnippet.svelte";
  import { formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import type { RailTurn } from "./turn-rail.ts";

  let { turn, class: className }: { turn: RailTurn; class?: ClassValue } = $props();
</script>

<div class={["grid w-72 gap-2 p-3", className]} data-turn-preview={turn.id}>
  <p class="truncate text-sm/5 font-medium" title={turn.title}><MarkdownSnippet text={turn.title} /></p>
  <p class="line-clamp-3 text-sm/5 text-zinc-500 dark:text-zinc-400">
    {#if turn.answer}<MarkdownSnippet text={turn.answer} />{:else}{turn.running ? "Waiting for the agent’s answer…" : "No answer in this turn."}{/if}
  </p>
  <p class="flex items-center gap-1.5 text-xs/5 text-zinc-500 tabular-nums dark:text-zinc-400"><span>Turn {turn.number}</span><span aria-hidden="true">·</span><time datetime={isoDateTime(turn.time)}>{formatDateTime(turn.time) || "Time unavailable"}</time></p>
</div>
