<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { workState } from "#lib/features/threads/activity.ts";
  import { workRowTones } from "#lib/features/threads/ThreadActivityMark.svelte";
  import ThreadHoverCard from "#lib/features/threads/ThreadHoverCard.svelte";

  /**
   * The link of a thread row in the sidebar (main and side threads): opens the thread, previews it on hover,
   * focus or tap-and-hold (ThreadHoverCard), tinted while the thread works or waits; the open thread's
   * highlight and hover sit on top. Layout and padding come from `class`.
   */
  let { thread, current = false, class: className, children }: { thread: ui.Thread; current?: boolean; class?: ClassValue; children: Snippet } = $props();
</script>

<ThreadHoverCard {thread}>
  {#snippet row(props)}
    <a
      {...props}
      href="/threads/{thread.id}"
      aria-current={current ? "page" : undefined}
      class={[
        "group focus-ring [-webkit-touch-callout:none]",
        workRowTones[workState(thread)],
        "hover:bg-zinc-950/4 aria-[current=page]:bg-zinc-950/6 dark:hover:bg-white/4 dark:aria-[current=page]:bg-white/8",
        className,
      ]}
    >
      {@render children()}
    </a>
  {/snippet}
</ThreadHoverCard>
