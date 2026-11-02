<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { isCalm, needsYou } from "#lib/features/threads/activity.ts";
  import { lingeringResult } from "#lib/features/threads/result.svelte.ts";
  import ThreadHoverCard from "#lib/features/threads/ThreadHoverCard.svelte";

  /**
   * The link of a thread row in the sidebar (main and side threads): opens the thread, previews it on hover,
   * focus or tap-and-hold (ThreadHoverCard). What wants you stands out, what is busy on its own steps back:
   * amber tint when it needs you, `data-result` while a finished turn waits to be seen, `data-calm` while it
   * works or asks its agent (rows dim their text, `group-data-calm:`, the activity mark stays clear). The
   * open thread's highlight and hover sit on top. Layout and padding come from `class`.
   */
  let { thread, current = false, class: className, children }: { thread: ui.Thread; current?: boolean; class?: ClassValue; children: Snippet } = $props();
  const result = lingeringResult(() => thread);
</script>

<ThreadHoverCard {thread}>
  {#snippet row(props)}
    <a
      {...props}
      href="/threads/{thread.id}"
      aria-current={current ? "page" : undefined}
      data-calm={isCalm(thread) || undefined}
      data-result={result.current}
      class={[
        "group focus-ring [-webkit-touch-callout:none]",
        needsYou(thread) && "bg-amber-500/6 inset-ring inset-ring-amber-500/20 dark:bg-amber-400/6 dark:inset-ring-amber-400/15",
        "hover:bg-zinc-950/4 aria-[current=page]:bg-zinc-950/6 dark:hover:bg-white/4 dark:aria-[current=page]:bg-white/8",
        className,
      ]}
    >
      {@render children()}
    </a>
  {/snippet}
</ThreadHoverCard>
