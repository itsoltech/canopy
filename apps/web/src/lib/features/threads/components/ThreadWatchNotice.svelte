<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ThreadState } from "../thread-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let { view, class: className }: { view: ThreadState; class?: ClassValue } = $props();
</script>

{#if view.failure}
  <Alert tone="warning" banner class={className}>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="min-w-0 flex-1 basis-64">{view.failure}</p>
      <div class="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onclick={() => view.history.retry()}>Retry</Button>
        <Button size="sm" variant="ghost" onclick={() => view.history.loadFromScratch()}>Load from scratch</Button>
      </div>
    </div>
  </Alert>
{/if}
