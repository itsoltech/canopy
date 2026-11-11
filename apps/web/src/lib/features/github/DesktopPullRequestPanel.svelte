<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import PullRequestPanel from "./PullRequestPanel.svelte";

  let { id, threadId, onclose }: { id: string; threadId: string; onclose: () => void } = $props();
  const wide = new MediaQuery("(min-width: 80rem)");
</script>

{#if wide.current}<PullRequestPanel {id} {threadId} {onclose} />{/if}
