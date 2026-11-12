<script lang="ts">
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import type { ClassValue } from "svelte/elements";

  let {
    header = false,
    rows = 3,
    class: className,
  }: { header?: boolean; rows?: number; class?: ClassValue } = $props();
</script>

<div role="status" aria-label="Loading pull request" aria-busy="true" class={["grid min-w-0 gap-4 py-4", className]}>
  {#if header}<Skeleton class="h-5 w-3/4" /><Skeleton class="h-12 w-full" />{/if}
  {#each Array.from({ length: rows }) as _, i (i)}
    <div class="flex min-w-0 gap-3">
      <Skeleton class="size-8 shrink-0 rounded-full" />
      <div class="grid flex-1 gap-2"><Skeleton class="h-5 w-2/3" /><Skeleton class="h-16 w-full" /></div>
    </div>
  {/each}
</div>
