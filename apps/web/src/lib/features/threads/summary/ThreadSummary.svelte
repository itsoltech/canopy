<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { ui } from "@canopy/contracts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import { refreshActivities } from "#lib/shared/activity.ts";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";
  import type { ThreadTree } from "../thread-tree.ts";
  import ThreadSummaryHeader from "./ThreadSummaryHeader.svelte";
  import ThreadSummaryPill from "./ThreadSummaryPill.svelte";

  /**
   * The thread summary: its own element in the thread area's top-right corner, never part of the right panel, and
   * never in the chat column's way. Where it fits beside the chat column (`docked`), the summary follows one choice
   * on this device: a fixed-width card as tall as its content, at most to the bottom of the area (it then scrolls
   * inside), or a pill. Elsewhere it is always the pill, and the pill opens the card as a
   * popover under it that closes on Escape, a click outside, a thread change or a resize; the device choice is
   * untouched. Narrow areas open a sheet instead. The card grows from the pill's corner (motion.css `t-summary`).
   */
  let {
    thread,
    tree,
    floating,
    docked,
    children,
    preview,
    pillWidth = $bindable(0),
  }: {
    thread: ui.Thread;
    tree: ThreadTree | undefined;
    /** The area fits the card as a popover; otherwise the pill opens a sheet. */
    floating: boolean;
    /** The right gutter beside the chat column holds the card. */
    docked: boolean;
    children: Snippet;
    preview?: Snippet;
    pillWidth?: number;
  } = $props();

  const id = $props.id();
  let pill = $state<HTMLButtonElement>();
  let card = $state<HTMLElement>();
  let previewRoot = $state<HTMLElement>();
  let sheet = $state(false);
  let popover = $state(false);
  let cardHeight = $state(0);
  let pillHeight = $state(0);
  let previewHeight = $state(0);
  const pinned = $derived(docked && !device.view.threadPanelCollapsed);
  const open = $derived(pinned || (floating && popover));
  const subagents = $derived(tree?.sides.filter((side) => side.spawnedByAgent).length ?? 0);

  // Both layers stay mounted: changing inert alone does not notify the activity observer.
  $effect(() => {
    void pinned;
    void open;
    void tick().then(refreshActivities);
  });

  // A popover is transient: another thread or another placement closes it.
  $effect(() => {
    void thread.id;
    void docked;
    void floating;
    popover = false;
  });

  $effect(() => {
    if (floating) sheet = false;
  });

  async function show() {
    if (!floating) {
      sheet = true;

      return;
    }

    if (docked) device.setView({ threadPanelCollapsed: false });
    else popover = true;
    await tick();
    card?.querySelector<HTMLElement>("[data-summary-collapse] button")?.focus();
  }

  async function hide(returnFocus: boolean) {
    const focused = card?.contains(document.activeElement);

    if (pinned) device.setView({ threadPanelCollapsed: true });
    popover = false;
    await tick();

    if (returnFocus && focused) pill?.focus();
  }

  // Open popovers handle Escape at the Svelte event root, after this listener.
  const escapeCloses: Attachment<HTMLElement> = (node) => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (event.target instanceof Element && event.target.closest(":popover-open")) return;

      event.preventDefault();
      void hide(true);
    };

    node.addEventListener("keydown", keydown);

    return () => node.removeEventListener("keydown", keydown);
  };

  // A click outside the popover and its pill closes it; the clicked target keeps focus.
  $effect(() => {
    if (!popover) return;

    const pointerdown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;

      if (card?.contains(event.target) || pill?.contains(event.target) || previewRoot?.contains(event.target)) return;

      // Pickers and menus opened from the card render in the top layer, outside it.
      if (event.target instanceof Element && event.target.closest(".density-overlay, dialog")) return;
      void hide(false);
    };

    document.addEventListener("pointerdown", pointerdown, true);

    return () => document.removeEventListener("pointerdown", pointerdown, true);
  });
</script>

<!-- Beside the timeline, both summary states share its top edge. Narrow layouts reserve a row for the pill. -->
<div
  class={["t-summary-pill z-30 mt-3 mr-4 flex max-w-[calc(100%-2rem)] justify-end", docked && "absolute top-0 right-0"]}
  style:margin-bottom={!docked && preview ? `calc(${previewHeight}px + .75rem)` : undefined}
  data-hidden={pinned || undefined}
  inert={pinned}
  bind:contentRect={
    null,
    (rect: DOMRectReadOnly) => {
      pillHeight = Math.round(rect.height);
      pillWidth = Math.ceil(rect.width);
    }
  }
>
  <ThreadSummaryPill
    {thread}
    {subagents}
    expanded={open || sheet}
    controls={floating ? id : undefined}
    onopen={() => (popover ? void hide(false) : void show())}
    bind:pill
  />
</div>
<div
  class="pointer-events-none absolute inset-y-3 right-4 z-30 w-80 max-w-[calc(100%-2rem)] [--summary-card-top:--spacing(10)] sm:[--summary-card-top:--spacing(9)]"
  style:--summary-card-top={pinned ? "0px" : undefined}
>
  {#if floating}
    <section
      bind:this={card}
      bind:contentRect={null, (rect: DOMRectReadOnly) => (cardHeight = Math.round(rect.height))}
      {id}
      aria-label="Thread details"
      class={[
        "t-summary pointer-events-auto absolute right-0 flex w-full flex-col overflow-hidden rounded-xl bg-white ring-1 ring-zinc-950/10 dark:shadow-none",
        pinned
          ? "top-0 max-h-full shadow-sm dark:bg-zinc-900 dark:ring-white/10"
          : "top-10 max-h-[max(16rem,calc(100%-14rem))] shadow-xl sm:top-9 dark:bg-zinc-800 dark:ring-white/15",
      ]}
      data-hidden={!open || undefined}
      style:max-height={preview
        ? `max(0px, calc(100% - ${previewHeight + 12}px - var(--summary-card-top)))`
        : undefined}
      inert={!open}
      {@attach escapeCloses}
    >
      <ThreadSummaryHeader {pinned} controls={id} onclose={() => void hide(true)} />
      <div class="min-h-0 scroll-stable-both overflow-y-auto overscroll-contain px-1 pb-1">{@render children()}</div>
    </section>
  {/if}
  {#if preview}
    <div
      bind:this={previewRoot}
      class="pointer-events-auto absolute right-0 w-full"
      class:hidden={sheet}
      inert={sheet}
      style:top={`calc(${open && floating ? "var(--summary-card-top)" : "0px"} + ${open && floating ? cardHeight : pillHeight}px + .75rem)`}
      bind:contentRect={null, (rect: DOMRectReadOnly) => (previewHeight = Math.round(rect.height))}
    >
      {@render preview()}
    </div>
  {/if}
</div>

{#if !floating}
  <Dialog bind:open={sheet} title="Thread details" sheet>
    {#if sheet}{@render children()}{/if}
  </Dialog>
{/if}
