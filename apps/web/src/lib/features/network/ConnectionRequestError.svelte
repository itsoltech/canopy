<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";

  let {
    title,
    error,
    loaded,
    loading,
    onretry,
    class: className,
  }: {
    title: string;
    error: string;
    loaded: boolean;
    loading: boolean;
    onretry: () => void;
    class?: ClassValue;
  } = $props();

  const longError = $derived(error.length > 160);
</script>

<Alert tone={loaded ? "warning" : "error"} {title} class={className}>
  <div class="grid min-w-0 gap-2">
    <p class={longError ? "line-clamp-3" : undefined}>{error}</p>
    {#if loaded}<p>Showing the last known state. It may have changed.</p>{/if}
    <div>
      <Button size="sm" disabled={loading} {loading} onclick={onretry}>{loading ? "Retrying…" : "Retry"}</Button>
    </div>
    {#if longError}
      <Disclosure>
        {#snippet summary()}Show error details{/snippet}
        <p class="py-2 wrap-anywhere whitespace-pre-wrap">{error}</p>
      </Disclosure>
    {/if}
  </div>
</Alert>
