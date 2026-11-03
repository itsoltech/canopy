<script lang="ts">
  import type { ItemStatus, WebSearch } from "@canopy/contracts";
  import { prettyJson, str } from "#lib/shared/format.ts";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import { safeHref } from "#lib/shared/ui/markdown/safe-url.ts";
  import ItemFrame from "./ItemFrame.svelte";

  /** Web search: the query, and the results as links when they have a recognisable shape. */
  let { search, status }: { search: WebSearch; status: ItemStatus } = $props();

  const results = $derived.by(() => {
    try {
      const value: unknown = JSON.parse(search.resultsJson);
      const list = Array.isArray(value) ? value : [];
      return list.flatMap((r: Record<string, unknown>) => {
        const href = safeHref(str(r?.["url"]));
        return href ? [{ href, title: str(r["title"]) || href }] : [];
      });
    } catch {
      return [];
    }
  });
</script>

<ItemFrame icon="globe-alt" {status}>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5"><span class="shrink-0">Searched the web</span><span class="truncate text-zinc-800 dark:text-zinc-200">{search.query}</span></span>
  {/snippet}
  {#if results.length > 0}
    <ul role="list" class="grid gap-1">
      {#each results as result (result.href)}
        <li class="truncate"><a href={result.href} target="_blank" rel="noopener noreferrer nofollow" class="text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-sky-700 dark:text-sky-400">{result.title}</a></li>
      {/each}
    </ul>
  {:else if search.resultsJson}
    <CodeBlock text={prettyJson(search.resultsJson)} label="Search results" />
  {:else}
    <p class="text-sm/5 text-zinc-500 italic sm:text-xs/5 dark:text-zinc-400">No results recorded.</p>
  {/if}
</ItemFrame>
