<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import AgentWell from "./items/AgentWell.svelte";
  import ThreadLink from "./items/ThreadLink.svelte";

  /** Top of a subagent's timeline: which thread's agent started it and where its result goes. */
  let {
    parentThreadId,
    parentTitle,
    class: className,
  }: { parentThreadId: string; parentTitle?: string | undefined; class?: ClassValue } = $props();
</script>

<AgentWell class={["grid min-w-0 gap-1", className]}>
  <p
    class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300"
  >
    Subagent started by <ThreadLink threadId={parentThreadId} fallback={parentTitle || "the parent thread"} />
  </p>
  <p class="text-sm/5 text-pretty text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    The parent agent receives the final reply by default. You can steer the subagent here.
  </p>
</AgentWell>
