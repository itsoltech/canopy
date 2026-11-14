<script lang="ts">
  import type { Snippet } from "svelte";
  import type { WebComposerDraft } from "./state.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";

  let { draft, children }: { draft: WebComposerDraft; children?: Snippet } = $props();
</script>

{#if draft.moved}
  <div class="flex min-w-0 flex-1 items-center gap-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    <p role="status" class="min-w-0 flex-1 truncate" title={draft.moved}>{draft.moved}</p>
    <Button size="sm" variant="ghost" onclick={() => (draft.moved = "")}>Dismiss</Button>
  </div>
{:else}{@render children?.()}{/if}
