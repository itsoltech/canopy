<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { citationPreview, type NotedQuote } from "@canopy/domain";
  import { safeHref } from "@canopy/domain/markdown";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import InlineLink from "#lib/shared/ui/InlineLink.svelte";

  let { quote, class: className }: { quote: NotedQuote; class?: ClassValue } = $props();
  const preview = $derived(citationPreview(quote));
  const href = $derived(safeHref(preview.url));
</script>

<div class={["grid min-w-0 gap-2 text-base/6 wrap-anywhere select-text sm:text-sm/5", className]}>
  <div class="max-h-72 min-h-0 overflow-y-auto overscroll-contain">
    {#if preview.markdown}
      <div
        class="[&_[role=heading]]:text-sm/5 sm:[&_[role=heading]]:text-xs/4 [&>div]:gap-2 [&>div]:text-base/6 sm:[&>div]:text-sm/5"
      >
        <Markdown text={preview.text} />
      </div>
    {:else}
      <p class="whitespace-pre-wrap">{preview.text}</p>
    {/if}
  </div>
  <div class="grid gap-1 text-sm/5 text-muted sm:text-xs/4">
    <p>{preview.caption}</p>
    {#if href}
      <InlineLink
        {href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="w-fit text-sky-700 underline underline-offset-2 focus-ring dark:text-sky-400">Open on GitHub</InlineLink
      >
    {/if}
  </div>
  {#if preview.comment}<p class="max-h-32 overflow-y-auto whitespace-pre-wrap">{preview.comment}</p>{/if}
</div>
