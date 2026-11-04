<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { safeHref } from "./markdown/safe-url.ts";

  /**
   * A link to a page outside the app (a fetched URL, a search result): new tab, no referrer, underlined in
   * sky. An address that is not safe to open (not http/https) shows as plain text.
   */
  let {
    href,
    title,
    class: className,
    children,
  }: { href: string; title?: string | undefined; class?: ClassValue; children: Snippet } = $props();

  const safe = $derived(safeHref(href));
</script>

{#if safe}
  <a
    href={safe}
    {title}
    target="_blank"
    rel="noopener noreferrer nofollow"
    class={[
      "text-sky-700 underline decoration-sky-700/30 underline-offset-2 hover:decoration-sky-700 dark:text-sky-400 dark:decoration-sky-400/30",
      className,
    ]}>{@render children()}</a
  >
{:else}
  <span class={className}>{@render children()}</span>
{/if}
