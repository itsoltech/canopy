<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import AgentWell from "./items/AgentWell.svelte";
  import ThreadLink from "./items/ThreadLink.svelte";

  /** Top of a subagent's timeline: which thread's agent started it and where its result goes. */
  let { parentThreadId, parentTitle, class: className }: { parentThreadId: string; parentTitle?: string | undefined; class?: ClassValue } =
    $props();
</script>

<AgentWell class={["flex items-start gap-2", className]}>
  <Icon name="sparkles" class="mt-1 shrink-0 fill-violet-500 dark:fill-violet-400" />
  <div class="grid min-w-0 gap-1">
    <p class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300">
      Subagent started by <ThreadLink threadId={parentThreadId} fallback={parentTitle || "the parent thread"} />
    </p>
    <p class="text-sm/5 text-pretty text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      Its final message goes back to that thread. You can write here to steer it.
    </p>
  </div>
</AgentWell>
