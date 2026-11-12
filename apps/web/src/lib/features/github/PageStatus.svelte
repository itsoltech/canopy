<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    page,
    busy,
    error,
    retry,
    class: className,
  }: {
    page?: github.PullRequestPageInfo;
    busy: boolean;
    error: string;
    retry: () => void;
    class?: ClassValue;
  } = $props();
</script>

<div
  aria-busy={busy || undefined}
  class={["grid gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}
>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if page?.detail}<p role="status">{page.detail}</p>{/if}
  {#if page?.stale && page.detail}<p role="status">Last verified data shown. Connect to refresh this page.</p>{/if}
  {#if error || page?.detail}<Button variant="ghost" disabled={busy} onclick={retry}>Retry</Button>{/if}
</div>
