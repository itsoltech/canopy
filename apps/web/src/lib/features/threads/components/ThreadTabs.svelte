<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { statusLook } from "#lib/shared/ui/status.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { ThreadTree } from "../thread-tree.ts";

  /** Compact thread switcher for narrow screens: main thread and side threads as scrolling tabs. */
  let { tree, currentId, class: className }: { tree: ThreadTree; currentId: string; class?: ClassValue } = $props();
  const threads = $derived([tree.main, ...tree.sides]);
</script>

<nav aria-label="Threads in this tree" class={["overflow-x-auto", className]}>
  <ul role="list" class="flex w-max gap-1 px-4 py-2 sm:px-6">
    {#each threads as thread, index (thread.id)}
      {@const look = statusLook(thread.status)}
      <li>
        <a
          href="/threads/{thread.id}"
          aria-current={thread.id === currentId ? "page" : undefined}
          class={[
            "flex max-w-56 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm/5 text-zinc-600 ring-1 ring-zinc-950/10 hover:bg-zinc-950/5 focus-ring aria-[current=page]:bg-zinc-950/5 aria-[current=page]:text-zinc-950 aria-[current=page]:ring-zinc-950/20 dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-white/5 dark:aria-[current=page]:bg-white/10 dark:aria-[current=page]:text-white",
            thread.spawnedByAgent && "ring-violet-500/30 dark:ring-violet-400/30",
          ]}
        >
          <StatusDot tone={look.tone} active={look.active} />
          <span class="truncate">{index === 0 ? "Main" : thread.title}</span>
          <span class="sr-only">({look.label}{thread.spawnedByAgent ? ", started by an agent" : ""})</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>
