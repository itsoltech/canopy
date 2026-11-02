<script lang="ts">
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";

  /**
   * The end of a thread before its snapshot arrives, shaped like the rows that replace it: a turn's
   * message (bubble on the right), the agent's lines, a tool row and the turn's footer, each with the
   * rows' own bottom spacing. `connecting` says so while the stream is not open yet.
   */
  let { connecting = false }: { connecting?: boolean } = $props();
  // Only a slow load shows it: a snapshot that arrives within 300 ms replaces an empty space instead of
  // a skeleton whose shapes never match the real rows.
  let shown = $state(false);
  $effect(() => {
    const timer = setTimeout(() => (shown = true), 300);
    return () => clearTimeout(timer);
  });
</script>

<div class={["grid grid-cols-1", !shown && "invisible"]} role="status" aria-label="Loading the timeline">
  <div class="flex justify-end pb-3"><Skeleton class="h-11 w-2/3 rounded-2xl rounded-br-md" /></div>
  <div class="grid gap-2 pb-3">
    <Skeleton class="h-4 w-full" />
    <Skeleton class="h-4 w-11/12" />
    <Skeleton class="h-4 w-3/5" />
  </div>
  <div class="flex items-center gap-2 pb-3"><Skeleton class="size-4 rounded-full" /><Skeleton class="h-4 w-1/3" /></div>
  <div class="flex items-center gap-3 pb-3"><Skeleton class="h-3 w-14" /><Skeleton class="h-3 w-24" /></div>
  <p class={["h-5 text-sm/5 text-zinc-500 dark:text-zinc-400", !connecting && "invisible"]}>Connecting…</p>
</div>
