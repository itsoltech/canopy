<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { isCalm, needsYou } from "#lib/features/threads/activity.ts";
  import { lingeringResult } from "#lib/features/threads/result.svelte.ts";
  import ThreadHoverCard from "#lib/features/threads/ThreadHoverCard.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import { longPress } from "#lib/shared/ui/long-press.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ThreadMenuItems from "#lib/features/threads/components/ThreadMenuItems.svelte";

  /**
   * The link of a thread row in the sidebar (main and side threads): opens the thread, previews it on hover,
   * or focus (ThreadHoverCard); right click, long press and Menu/Shift+F10 open its actions. What wants you stands out:
   * amber tint when it needs you, `data-result` while a finished turn waits to be seen, `data-calm` while it
   * works or asks its agent (rows dim their text, `group-data-calm:`, the activity mark stays clear). The
   * open thread's highlight and hover sit on top. Layout and padding come from `class`.
   */
  let { thread, current = false, class: className, children }: { thread: ui.Thread; current?: boolean; class?: ClassValue; children: Snippet } = $props();
  const result = lingeringResult(() => thread);
  let open = $state(false);
  function context(event: MouseEvent | KeyboardEvent) { event.preventDefault(); event.stopPropagation(); open = true; }
</script>

<DropdownMenu bind:open label="Actions for {thread.title}" sheet placement="bottom-start" class="w-64">
{#snippet trigger(menu)}
<div class="group/row relative">
<ThreadHoverCard {thread} touch="none" disabled={open}>
  {#snippet row(props)}
    <a
      {...props}
      {...anchorOnly(menu)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menu["aria-controls"]}
      oncontextmenu={context}
      onkeydown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) context(event); }}
      {@attach longPress(() => (open = true))}
      href="/threads/{thread.id}"
      aria-current={current ? "page" : undefined}
      data-calm={isCalm(thread) || undefined}
      data-result={result.current}
      data-unread={thread.markedUnread || undefined}
      class={[
        "group focus-ring [-webkit-touch-callout:none]",
        needsYou(thread) && "bg-amber-500/6 inset-ring inset-ring-amber-500/20 dark:bg-amber-400/6 dark:inset-ring-amber-400/15",
        "hover:bg-zinc-950/4 aria-[current=page]:bg-zinc-950/6 dark:hover:bg-white/4 dark:aria-[current=page]:bg-white/8",
        className,
        "pr-9",
        thread.status === "archived" && "opacity-60",
      ]}
    >
      {@render children()}
      {#if thread.markedUnread}<span class="sr-only">Unread</span><span class="absolute top-3 right-3 size-1.5 rounded-full bg-brand-500" aria-hidden="true"></span>{/if}
    </a>
  {/snippet}
</ThreadHoverCard>
<IconButton icon="ellipsis-horizontal" label="Actions for {thread.title}" size="sm"
  aria-haspopup="menu" aria-expanded={open} aria-controls={menu["aria-controls"]}
  onclick={() => (open = !open)} onkeydown={menu.onkeydown}
  class="absolute top-1.5 right-1 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100 pointer-coarse:hidden" />
</div>
{/snippet}
<ThreadMenuItems {thread} />
</DropdownMenu>
