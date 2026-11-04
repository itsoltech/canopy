<script lang="ts">
  import type { Snippet } from "svelte";

  /** One breadcrumb step; links when `href` is set. A slash separates it from the previous one. */
  let { href, children }: { href?: string | undefined; children: Snippet } = $props();
</script>

<li
  class="flex min-w-0 items-center gap-2 not-first:before:text-zinc-300 not-first:before:content-['/'] dark:not-first:before:text-zinc-700"
>
  {#if href}
    <a
      {href}
      class="flex min-w-0 items-center gap-2 truncate rounded-sm focus-ring hover:text-zinc-950 dark:hover:text-white"
      >{@render children()}</a
    >
  {:else}
    <span class="flex min-w-0 items-center gap-2 truncate" aria-current="page">{@render children()}</span>
  {/if}
</li>
