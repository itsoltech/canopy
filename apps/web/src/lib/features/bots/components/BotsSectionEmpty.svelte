<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";

  /** The Bots section of the sidebar until bots exist: what they are, and the way to make the first one. */
  let { query = "", class: className }: { query?: string; class?: ClassValue } = $props();
</script>

{#if query.trim()}
  <p class={["px-3 py-2 text-sm/6 text-pretty text-zinc-500 dark:text-zinc-400", className]}>
    No bots yet, so nobody here answers to “{query}”.
  </p>
{:else}
  <EmptyState
    icon="chat-bubble-left-right"
    title="No bots yet"
    description="A bot is a chat partner that remembers the conversation. It can use your connected accounts and agents."
    class={className}
  >
    {#snippet action()}<ButtonLink href="/bots?create=1" icon="plus" variant="primary">Create bot</ButtonLink>{/snippet}
  </EmptyState>
{/if}
