<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import PullRequestPanel from "./PullRequestPanel.svelte";

  let { id, threadId, onclose }: { id: string; threadId: string; onclose: () => void } = $props();
  const wide = new MediaQuery("(min-width: 80rem)");
  let open = $state(false);

  $effect(() => {
    open = Boolean(id) && !wide.current;
  });

  $effect(() => {
    if (id && !wide.current && !open) onclose();
  });
</script>

{#if !wide.current}<Dialog bind:open title="Pull request" size="lg" fullscreen bare class="h-[90dvh] overflow-hidden"
    ><PullRequestPanel {id} {threadId} {onclose} /></Dialog
  >{/if}
