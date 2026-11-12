<script lang="ts">
  import type { ContextCompaction } from "@canopy/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import LazyItemContent from "./LazyItemContent.svelte";
  import { useLazyContent } from "./lazy-content.ts";
  import { ContentExpansion } from "./content-expansion.svelte.ts";

  /** The provider summarised older context to make room; the summary replaces it from here on. */
  let { compaction }: { compaction: ContextCompaction } = $props();
  let open = $state(false);
  const expansion = new ContentExpansion(() => open);
  const lazy = useLazyContent();
  const lazyContent = $derived(lazy());
</script>

<div class="flex items-center gap-3 py-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
  <span class="h-px flex-1 bg-zinc-950/10 dark:bg-white/10"></span>
  {#if compaction.summary}
    <Disclosure bind:open remember="compaction" summaryClass="px-1">
      {#snippet summary()}Context compacted{/snippet}
      <Markdown text={compaction.summary} class="mt-2 text-zinc-600 dark:text-zinc-400" />
      {#if lazyContent}
        {#key lazyContent.reference.sha256}
          <LazyItemContent
            {...lazyContent}
            auto
            signal={expansion.signal}
            active={open && !!expansion.signal}
            subject="summary"
          />
        {/key}
      {/if}
    </Disclosure>
  {:else}
    <span>Context compacted</span>
  {/if}
  <span class="h-px flex-1 bg-zinc-950/10 dark:bg-white/10"></span>
</div>
