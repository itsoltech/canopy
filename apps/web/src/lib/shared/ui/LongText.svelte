<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Markdown from "./markdown/Markdown.svelte";
  import MoreButton from "./MoreButton.svelte";
  import { useRemembered } from "./memory.ts";

  /**
   * A long text value (a prompt, a message, a note): its first lines until "Show all". `markdown` renders it
   * as markdown (agent text), otherwise it keeps its line breaks as written.
   */
  let { text, markdown = false, lines = 6, class: className }: { text: string; markdown?: boolean; lines?: number; class?: ClassValue } = $props();

  // Long: more lines than shown, or one long paragraph (about 90 characters per line at this width).
  const long = $derived(text.split("\n").length > lines || text.length > lines * 90);
  const memory = useRemembered<boolean>("text-all");
  let all = $state(memory?.get() ?? false);
  $effect(() => memory?.set(all));
  const clamp = $derived(long && !all);
</script>

<div class={["grid gap-1", className]}>
  <div class={["min-w-0 text-base/6 text-pretty text-zinc-700 sm:text-sm/6 dark:text-zinc-300", clamp && "max-h-(--clamp) overflow-hidden mask-b-from-60%"]} style:--clamp={clamp ? `${lines * 1.5}rem` : undefined}>
    {#if markdown}<Markdown {text} />{:else}<p class="break-words whitespace-pre-wrap">{text}</p>{/if}
  </div>
  {#if long}
    <div data-quote-skip class="text-sm/5 sm:text-xs/5"><MoreButton expanded={all} onclick={() => (all = !all)}>{all ? "Show less" : "Show all"}</MoreButton></div>
  {/if}
</div>
