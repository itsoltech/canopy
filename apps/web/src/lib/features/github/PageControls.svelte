<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { github } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    page,
    busy,
    error,
    previous,
    next,
    retry,
    class: className,
  }: {
    page?: github.PullRequestPageInfo;
    busy: boolean;
    error: string;
    previous?: (() => void) | undefined;
    next: () => void;
    retry: () => void;
    class?: ClassValue;
  } = $props();
</script>

<div class={["grid gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}>
  {#if error}<p role="alert">{error}</p>
    <Button variant="ghost" onclick={retry}>Retry</Button>{/if}
  {#if page?.detail}<p role="status">{page.detail}</p>{/if}
  {#if page?.stale}<p role="status">Last verified data shown. Connect to refresh this page.</p>{/if}
  <div class="flex items-center gap-2">
    {#if previous}<Button variant="ghost" disabled={busy} onclick={previous}>Previous page</Button>{/if}
    {#if page?.nextCursor}<Button variant="ghost" disabled={busy} onclick={next}>Next page</Button>{/if}
    {#if busy}<p role="status">Loading page…</p>{/if}
  </div>
</div>
