<script lang="ts">
  import type { CodeToken } from "./incremental.ts";

  /** One highlighted line; a token without a colour takes the text colour around it. */
  let { tokens }: { tokens: readonly CodeToken[] } = $props();
</script>

<!-- One line: this renders inside a <pre>, where whitespace in the template would show. -->
{#each tokens as token, index (index)}{#if token.color}<span style:color={token.color}>{token.content}</span>{:else}{token.content}{/if}{/each}
