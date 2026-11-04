<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { forkFrom, forking } from "../fork.svelte.ts";

  /** "Fork from here": a new thread with the history of `threadId` up to and including `turnId`; a spinner until it opens. */
  let { threadId, turnId, class: className }: { threadId: string; turnId: string; class?: ClassValue } = $props();
  const busy = $derived(forking.has(turnId));
</script>

<IconButton
  icon="git-fork"
  size="sm"
  label={busy ? "Forking…" : "Fork from here"}
  loading={busy}
  class={className}
  onclick={() => forkFrom(threadId, turnId)}
/>
