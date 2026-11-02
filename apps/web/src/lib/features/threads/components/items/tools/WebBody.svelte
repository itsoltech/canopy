<script lang="ts">
  import { str } from "#lib/shared/format.ts";
  import LongText from "#lib/shared/ui/LongText.svelte";
  import ExternalLink from "#lib/shared/ui/ExternalLink.svelte";
  import type { ToolBodyProps } from "./body.ts";
  import { parseWebResults, shortUrl, stripReminders } from "./parse.ts";
  import ResultText from "./ResultText.svelte";
  import Section from "./Section.svelte";

  /**
   * WebFetch and web searches: the page (link) and what the agent asked about it, or the query; then the
   * links found and the answer as markdown, collapsed when long.
   */
  let { call, input, status, streaming }: ToolBodyProps = $props();
  const url = $derived(str(input["url"]));
  const ask = $derived(str(input["prompt"]));
  const results = $derived(call.isError || streaming ? undefined : parseWebResults(call.output));
  const fetched = $derived(call.isError || streaming ? "" : stripReminders(call.output).trim());
</script>

{#if url}
  <p class="truncate text-base/6 sm:text-sm/6"><ExternalLink href={url}>{url}</ExternalLink></p>
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
        <li class="flex min-w-0 items-baseline gap-2">
          <ExternalLink href={link.url} title={link.url} class="truncate">{link.title}</ExternalLink>
          <span class="shrink-0 truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{shortUrl(link.url).split("/")[0]}</span>
        </li>
      {/each}
    </ul>
  {/if}
  {#if results.text}<LongText text={results.text} markdown lines={8} />{/if}
{:else}
  <ResultText {call} {status} {streaming} />
{/if}
