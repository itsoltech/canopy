<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { github } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import { readStatus } from "./presentation.ts";
  import PageStatus from "./PageStatus.svelte";

  let {
    page,
    busy,
    error,
    previous,
    next,
    retryLabel,
    offlineShown = false,
    retry,
    class: className,
  }: {
    page?: github.PullRequestPageInfo;
    busy: boolean;
    error: string;
    previous?: (() => void) | undefined;
    next: () => void;
    retryLabel: string;
    offlineShown?: boolean;
    retry: () => void;
    class?: ClassValue;
  } = $props();

  const detail = $derived(readStatus(page, offlineShown));
</script>

{#if detail || error || previous || page?.nextCursor}
  <div class={["grid gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}>
    <PageStatus {detail} {busy} {error} {retry} {retryLabel} />
    {#if previous || page?.nextCursor}<div class="flex items-center gap-2">
        {#if previous}<Button variant="ghost" disabled={busy} onclick={previous}>Previous page</Button>{/if}
        {#if page?.nextCursor}<Button variant="ghost" disabled={busy} onclick={next}>Next page</Button>{/if}
      </div>{/if}
  </div>
{/if}
