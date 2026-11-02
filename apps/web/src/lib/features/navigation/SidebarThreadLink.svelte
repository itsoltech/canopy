<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { tick, type Snippet } from "svelte";
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
  let { thread, current = false, compact = false, class: className, children }: { thread: ui.Thread; current?: boolean; compact?: boolean; class?: ClassValue; children: Snippet } = $props();
  const result = lingeringResult(() => thread);
  let open = $state(false);
  // Where the menu opens from: the pointer for a right click, under the "…" button for a click on it, under
  // the row for the keyboard and a long press (phones show it as a sheet anyway).
  let via = $state<"row" | "button" | "point">("row");
  let point = $state({ x: 0, y: 0 });
  let rowBox: HTMLElement | undefined = $state();
  // Closing returns focus to the anchor; the pointer's anchor is not focusable, so the row's link takes it.
  $effect(() => {
    if (open || via !== "point") return;
    void tick().then(() => {
      if (document.activeElement === document.body) rowBox?.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
    });
  });
  function context(event: MouseEvent | KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event instanceof MouseEvent && event.type === "contextmenu" && rowBox) {
      const box = rowBox.getBoundingClientRect();
      point = { x: event.clientX - box.left, y: event.clientY - box.top };
      via = "point";
    } else via = "row";
    open = true;
  }
</script>

<DropdownMenu bind:open label="Actions for {thread.title}" sheet placement={via === "button" ? "bottom-end" : "bottom-start"} class="w-64">
{#snippet trigger(menu)}
<div class="group/row relative" bind:this={rowBox}>
<span aria-hidden="true" class="pointer-events-none absolute size-0" style:left="{point.x}px" style:top="{point.y}px" {...(via === "point" ? anchorOnly(menu) : {})}></span>
<ThreadHoverCard {thread} touch="none" disabled={open}>
  {#snippet row(props)}
    <a
      {...props}
      {...(via === "row" ? anchorOnly(menu) : {})}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menu["aria-controls"]}
      oncontextmenu={context}
      onkeydown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) context(event); }}
      {@attach longPress(() => { via = "row"; open = true; })}
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
        thread.status === "archived" && !compact && "opacity-60",
      ]}
    >
      {@render children()}
      {#if thread.markedUnread}<span class="sr-only">Unread</span><span class="absolute top-3 right-3 size-1.5 rounded-full bg-brand-500" aria-hidden="true"></span>{/if}
    </a>
  {/snippet}
</ThreadHoverCard>
<!-- Floats over the row's time on hover (T3-style), positioned by its own box: IconButton's `relative` would
     beat an `absolute` passed in `class`. -->
<span {...(via === "button" ? anchorOnly(menu) : {})} class={["absolute right-1.5 flex rounded-lg bg-white shadow-xs ring-1 ring-zinc-950/10 opacity-0 pointer-events-none group-hover/row:pointer-events-auto group-focus-within/row:pointer-events-auto has-aria-[expanded=true]:pointer-events-auto dark:bg-zinc-800 dark:shadow-none dark:ring-white/10 group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-aria-[expanded=true]:opacity-100 pointer-coarse:hidden", compact ? "top-1 sm:top-0.5" : "top-1.5"]}>
  <IconButton icon="ellipsis-horizontal" label="Actions for {thread.title}" size="sm"
    aria-haspopup="menu" aria-expanded={open} aria-controls={menu["aria-controls"]}
    onclick={() => { via = "button"; open = !open; }} onkeydown={(event) => { via = "button"; menu.onkeydown?.(event); }} />
</span>
</div>
{/snippet}
<ThreadMenuItems {thread} />
</DropdownMenu>
