<script lang="ts">
  import { threadDraftPresence } from "./presence.svelte.ts";

  let { threadId }: { threadId: string } = $props();
  const draft = threadDraftPresence(() => threadId);
</script>

<!-- The slot is always reserved, on the side away from the title's alignment edge. -->
<span class="inline-flex w-8 shrink-0 justify-end" aria-hidden={!draft.current}>
  <span class:invisible={!draft.current}>Draft</span>
</span>
