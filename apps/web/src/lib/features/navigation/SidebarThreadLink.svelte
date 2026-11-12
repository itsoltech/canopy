<script lang="ts">
  import "./sidebar-rows.css";
  import type { ui } from "@canopy/contracts";
  import { tick, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { needsYou } from "#lib/features/threads/activity.ts";
  import { lingeringResult } from "#lib/features/threads/result.svelte.ts";
  import ThreadHoverCard from "#lib/features/threads/ThreadHoverCard.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import { longPress } from "#lib/shared/ui/long-press.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ThreadMenuItems from "#lib/features/threads/components/ThreadMenuItems.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import { useThreadActions } from "#lib/features/threads/thread-actions.svelte.ts";
  import SidebarQuickArchive from "./SidebarQuickArchive.svelte";
  import { focusAfterArchive } from "./sidebar-focus.ts";

  /**
   * The link of a thread row in the sidebar (main and side threads): opens the thread, previews it on hover,
   * or focus (ThreadHoverCard); right click, long press and Menu/Shift+F10 open its actions. What wants you stands out:
   * amber tint when it needs you, `data-result` while a finished turn waits to be seen. Working rows
   * keep normal text contrast and use their activity mark and status instead of a background.
   * The open thread keeps its selected background on hover. Layout and padding come from `class`.
   */
  let {
    thread,
    current = false,
    needsAttention = needsYou(thread),
    compact = false,
    quickArchive = false,
    class: className,
    children,
  }: {
    thread: ui.Thread;
    current?: boolean;
    needsAttention?: boolean;
    compact?: boolean;
    quickArchive?: boolean;
    class?: ClassValue;
    children: Snippet;
  } = $props();

  const result = lingeringResult(() => thread);
  const overview = useOverview();
  const actions = useThreadActions();
  const away = $derived(thread.nodeId ? awayReason(overview.computer(thread.nodeId)) : undefined);
  let open = $state(false);
  let archiving = $state(false);

  // Where the menu opens from: the pointer for a right click, under the "…" button for a click on it, under
  // the row for the keyboard and a long press (phones show it as a sheet anyway).
  let via = $state<"row" | "button" | "point">("row");
  let point = $state({ x: 0, y: 0 });
  let rowBox: HTMLElement | undefined = $state();

  // Closing returns focus to the anchor; the pointer's anchor is not focusable, so the row's link takes it.
  $effect(() => {
    if (open || via !== "point") return;
    void tick().then(() => {
      if (document.activeElement === document.body)
        rowBox?.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
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

  async function archive(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (archiving || away || thread.deletedAt) return;
    archiving = true;

    try {
      await actions.run("archive", thread, false, focusAfterArchive(rowBox));
    } finally {
      archiving = false;
    }
  }
</script>

<DropdownMenu
  bind:open
  label="Actions for {thread.title}"
  sheet
  placement={via === "button" ? "bottom-end" : "bottom-start"}
  class="w-64"
>
  {#snippet trigger(menu)}
    <div
      class="sidebar-action-row group/row relative"
      data-actions-open={open || undefined}
      data-sidebar-archive-row={quickArchive || undefined}
      bind:this={rowBox}
    >
      <span
        aria-hidden="true"
        class="pointer-events-none absolute size-0"
        style:left="{point.x}px"
        style:top="{point.y}px"
        {...via === "point" ? anchorOnly(menu) : {}}
      ></span>
      <ThreadHoverCard {thread} touch="none" disabled={open}>
        {#snippet row(props)}
          <a
            {...props}
            {...via === "row" ? anchorOnly(menu) : {}}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menu["aria-controls"]}
            oncontextmenu={context}
            onkeydown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) context(event);
            }}
            {@attach longPress(() => {
              via = "row";
              open = true;
            })}
            href="/threads/{thread.id}"
            aria-current={current ? "page" : undefined}
            data-result={result.current}
            data-unread={thread.markedUnread || undefined}
            class={[
              "sidebar-row group focus-ring [-webkit-touch-callout:none]",
              !away &&
                needsAttention &&
                "bg-amber-500/6 inset-ring inset-ring-amber-500/20 dark:bg-amber-400/6 dark:inset-ring-amber-400/15",
              "aria-[current=page]:bg-zinc-950/6 dark:aria-[current=page]:bg-white/8",
              !current && "hover:bg-zinc-950/4 dark:hover:bg-white/4",
              className,
              thread.status === "archived" && !compact && "opacity-60",
              away && "opacity-60 saturate-0",
            ]}
          >
            {@render children()}
            {#if away}<span class="sr-only">Read-only. {away}</span>{/if}
            {#if thread.markedUnread}<span class="sr-only">Unread</span><span
                class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand-500"
                aria-hidden="true"
              ></span>{/if}
          </a>
        {/snippet}
      </ThreadHoverCard>
      <!-- Floats over the row's time on hover, positioned by its own box: IconButton's `relative` would
     beat an `absolute` passed in `class`. -->
      <span
        {...via === "button" ? anchorOnly(menu) : {}}
        class={[
          "sidebar-swap-action absolute right-[calc(var(--sidebar-row-padding)-(--spacing(1.5)))] flex rounded-lg bg-white shadow-xs ring-1 ring-zinc-950/10 dark:bg-zinc-800 dark:shadow-none dark:ring-white/10 pointer-coarse:hidden",
          compact ? "top-1.5 sm:top-1" : "top-2",
        ]}
      >
        <IconButton
          icon="ellipsis-horizontal"
          label="Actions for {thread.title}"
          size="sm"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menu["aria-controls"]}
          onclick={() => {
            via = "button";
            open = !open;
          }}
          onkeydown={(event) => {
            via = "button";
            menu.onkeydown?.(event);
          }}
        />
      </span>
      {#if quickArchive}
        <SidebarQuickArchive
          archived={thread.status === "archived"}
          label="{thread.status === 'archived' ? 'Unarchive' : 'Archive'} thread {thread.title}"
          disabled={Boolean(away || thread.deletedAt)}
          loading={archiving}
          onclick={(event) => void archive(event)}
          class={compact
            ? "inset-y-0 right-11 my-auto"
            : "right-(--sidebar-row-padding) bottom-[0.6875rem] sm:bottom-2.5"}
        />
      {/if}
    </div>
  {/snippet}
  <ThreadMenuItems {thread} />
</DropdownMenu>
