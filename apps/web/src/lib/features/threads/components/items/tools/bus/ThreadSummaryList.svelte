<script lang="ts">
  import { plural } from "#lib/shared/humanize.ts";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { useThreadDirectory } from "../../../../thread-directory.ts";
  import type { ThreadSummary } from "../agent-bus.ts";

  /**
   * Threads as a bus call saw them (get_thread, wait_threads, list_threads): a status dot, the title linking
   * to the thread, how its last turn ended, what waits for whom, and the start of its last message (the
   * result). Status and title come from the live directory when the page knows the thread.
   */
  let { threads }: { threads: readonly ThreadSummary[] } = $props();
  const directory = useThreadDirectory();
</script>

<ul role="list" class="grid divide-y divide-zinc-950/5 dark:divide-white/10">
  {#each threads as summary (summary.threadId)}
    {@const live = directory.thread(summary.threadId)}
    {@const look = statusLook(live?.status || summary.status)}
    {@const waits = [summary.waitingForUser > 0 && `${plural(summary.waitingForUser, "question")} for you`, summary.waitingForParent > 0 && `${plural(summary.waitingForParent, "question")} for the parent agent`, summary.queuedTurns > 0 && `${plural(summary.queuedTurns, "turn")} queued`].filter(Boolean)}
    <li class="grid min-w-0 gap-0.5 py-2 first:pt-0 last:pb-0">
      <div class="flex min-w-0 items-center gap-2 text-base/6 sm:text-sm/6">
        <StatusDot tone={look.tone} active={look.active} class="shrink-0" />
        <a href="/threads/{summary.threadId}" class="min-w-0 truncate font-medium text-zinc-950 hover:underline focus-ring dark:text-white">{live?.title || summary.title || "Untitled thread"}</a>
        <span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{look.label}</span>
      </div>
      {#if summary.lastTurn || waits.length > 0}
        <p class="pl-4 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
          {[summary.lastTurn && `Last turn ${summary.lastTurn.charAt(0).toLowerCase()}${summary.lastTurn.slice(1)}`, ...waits].filter(Boolean).join(" · ")}
        </p>
      {/if}
      {#if summary.lastMessage}
        <p class="line-clamp-2 pl-4 text-base/6 text-pretty whitespace-pre-line text-zinc-700 sm:text-sm/6 dark:text-zinc-300"><span class="sr-only">Last message: </span>{summary.lastMessage}</p>
      {/if}
    </li>
  {/each}
</ul>
