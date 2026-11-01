<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";

  /** The Bots section of the sidebar until bots exist: what they will be, no made-up data. */
  let { query = "", class: className }: { query?: string; class?: ClassValue } = $props();
</script>

{#if query.trim()}
  <p class={["px-3 py-2 text-sm/6 text-pretty text-zinc-500 dark:text-zinc-400", className]}>No bots yet, so nothing matches “{query}”.</p>
{:else}
  <EmptyState
    icon="chat-bubble-left-right"
    title="No bots yet"
    description="Bots live in the gateway and will arrive here. Chat with one, bring several into a group, or watch two of them work something out."
    class={className}
  />
{/if}
