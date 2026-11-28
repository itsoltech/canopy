<script lang="ts">
  import type { ContextCompaction } from "@canopy/contracts";
  import { compactionLabel } from "@canopy/domain/format";
  import TimelineDivider from "./TimelineDivider.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import LazyItemContent from "./LazyItemContent.svelte";
  import { useLazyContent } from "./lazy-content.ts";
  import { ContentExpansion } from "./content-expansion.svelte.ts";

  /** The provider summarised older context to make room; the summary replaces it from here on. */
  let { compaction }: { compaction: ContextCompaction } = $props();
  let open = $state(false);
  const label = $derived(compactionLabel(compaction));
  const expansion = new ContentExpansion(() => open);
  const lazy = useLazyContent();
  const lazyContent = $derived(lazy());
</script>

<TimelineDivider>
  {#if compaction.summary}
    <Disclosure bind:open remember="compaction" class="text-left" summaryClass="px-1">
      {#snippet summary()}{label}{/snippet}
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
    {label}
  {/if}
</TimelineDivider>
