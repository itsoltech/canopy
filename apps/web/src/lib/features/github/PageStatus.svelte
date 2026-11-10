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

<div class={["grid gap-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400", className]}>
  {#if error}<p role="alert">{error}</p>
    <Button variant="ghost" onclick={retry}>Retry</Button>{/if}
  {#if page?.detail}<p role="status">{page.detail}</p>{/if}
  {#if page?.stale}<p role="status">Last verified data shown. Connect to refresh this page.</p>{/if}
  {#if busy}<p role="status">Loading…</p>{/if}
</div>
