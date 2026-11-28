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

{#if compaction.summary}
  <Disclosure
    bind:open
    remember="compaction"
    align="center"
    class="mx-auto w-fit max-w-[min(100%,42rem)] py-1"
    summaryClass="mx-auto min-h-8 w-fit max-w-full flex-row-reverse bg-zinc-950/5 px-2.5 py-1 text-sm/5 text-zinc-700 hover:bg-zinc-950/8 sm:text-[0.8125rem]/5 dark:bg-white/8 dark:text-zinc-300 dark:hover:bg-white/12 pointer-coarse:min-h-11"
  >
    {#snippet summary()}<span class="wrap-anywhere">{label}</span>{/snippet}
    <div
      class="mt-1 min-w-0 rounded-xl bg-zinc-950/4 theme-message-padding text-zinc-700 dark:bg-white/5 dark:text-zinc-300"
    >
      <Markdown text={compaction.summary} />
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
    </div>
  </Disclosure>
{:else}
  <TimelineDivider>{label}</TimelineDivider>
{/if}
