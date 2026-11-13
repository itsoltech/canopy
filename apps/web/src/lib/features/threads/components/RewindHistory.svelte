<script lang="ts">
  import type { RewindFeedRow } from "../rewind-feed.ts";
  import { useThreadRewind } from "../rewind-state.svelte.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let { row }: { row: RewindFeedRow } = $props();
  const state = useThreadRewind();
  const directory = useThreadDirectory();
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm/5 text-muted sm:text-xs/5">
  <Icon name="arrow-uturn-left" class="size-3.5" />
  <span>{row.messages} {row.messages === 1 ? "message" : "messages"} rewound</span>
  <Button variant="ghost" size="sm" aria-expanded={row.open} onclick={() => state?.().toggle(row.rewindId)}
    >{row.open ? "Hide" : "Show"}</Button
  >
  {#if row.canUndo && !directory.readOnly}
    <Button
      variant="ghost"
      size="sm"
      disabled={state?.().busy}
      onclick={() => void state?.().restore(directory.currentId, row.rewindId)}>Undo</Button
    >
    <Button
      variant="ghost"
      size="sm"
      disabled={state?.().busy}
      onclick={() => void state?.().recover(directory.currentId, row.rewindId)}>Edit message</Button
    >
  {/if}
</div>
