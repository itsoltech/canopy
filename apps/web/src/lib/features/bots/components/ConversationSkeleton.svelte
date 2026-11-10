<script lang="ts">
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
</script>

<div
  role="status"
  aria-label="Loading conversation"
  class="mx-auto flex w-full max-w-(--bot-chat-width) flex-col gap-6 px-6 py-8"
>
  {#each [0, 1, 2, 3, 4, 5] as row (row)}
    <div class="flex gap-3" class:justify-end={row % 2 === 1}>
      {#if row % 2 === 0}<Skeleton class="size-7 shrink-0 rounded-full" />{/if}
      <div class="flex w-2/3 flex-col gap-2"><Skeleton class="h-4 w-1/3" /><Skeleton class="h-12 w-full" /></div>
    </div>
  {/each}
</div>
