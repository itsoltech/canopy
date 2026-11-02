<script lang="ts">
  import { str } from "#lib/shared/format.ts";
  import LongText from "#lib/shared/ui/LongText.svelte";
  import { safeHref } from "#lib/shared/ui/markdown/safe-url.ts";
  import type { ToolBodyProps } from "./body.ts";
  import { parseWebResults, shortUrl, stripReminders } from "./parse.ts";
  import ResultText from "./ResultText.svelte";
  import Section from "./Section.svelte";

  /**
   * WebFetch and web searches: the page (link) and what the agent asked about it, or the query; then the
   * links found and the answer as markdown, collapsed when long.
   */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const url = $derived(safeHref(str(input["url"])));
  const ask = $derived(str(input["prompt"]));
  const results = $derived(call.isError || streaming ? undefined : parseWebResults(call.output));
  const fetched = $derived(call.isError || streaming ? "" : stripReminders(call.output).trim());
</script>

{#if url}
  <p class="truncate text-base/6 sm:text-sm/6">
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" class="text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30">{str(input["url"])}</a>
  </p>
{/if}
{#if ask}
  <Section label="Asked"><LongText text={ask} lines={3} /></Section>
{/if}
{#if call.name === "WebFetch" && fetched}
  <Section label="Answer"><LongText text={fetched} markdown lines={8} /></Section>
{:else if results && (results.links.length > 0 || results.text)}
  {#if results.links.length > 0}
    <ul role="list" class="grid gap-1 text-base/6 sm:text-sm/6">
      {#each results.links as link (link.url)}
        {@const href = safeHref(link.url)}
        {#if href}
          <li class="flex min-w-0 items-baseline gap-2">
            <a {href} target="_blank" rel="noopener noreferrer nofollow" class="truncate text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30">{link.title}</a>
            <span class="shrink-0 truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{shortUrl(link.url).split("/")[0]}</span>
          </li>
        {/if}
      {/each}
    </ul>
  {/if}
  {#if results.text}<LongText text={results.text} markdown lines={8} />{/if}
{:else}
  <ResultText {call} {status} {streaming} />
{/if}
