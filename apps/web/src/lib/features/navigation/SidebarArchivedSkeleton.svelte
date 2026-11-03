<script lang="ts">
  import Delayed from "#lib/shared/ui/Delayed.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";

  /**
   * Rows of the Archived list before its first page arrives, shaped and sized like SidebarArchivedThread
   * (mark, title, age; 36 px, 40 px on phones), so the rows replace them in place. Only a slow load shows
   * them (after 200 ms), fading in; the list's height eases to theirs.
   */
  let { rows }: { rows: number } = $props();
</script>

<Delayed ms={200}>
  {#each { length: rows }, index (index)}
    <li aria-hidden="true" class="t-reveal flex h-10 items-center gap-2 px-3 sm:h-9">
      <Skeleton class="size-4.5 shrink-0" />
      <Skeleton class={["h-3.5", index % 3 === 0 ? "w-3/5" : index % 3 === 1 ? "w-4/5" : "w-1/2"]} />
      <Skeleton class="ml-auto h-3 w-6 shrink-0" />
    </li>
  {/each}
</Delayed>
