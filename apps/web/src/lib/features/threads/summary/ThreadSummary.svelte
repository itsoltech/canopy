<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { ui } from "@canopy/contracts";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";
  import type { ThreadTree } from "../thread-tree.ts";
  import ThreadSummaryPill from "./ThreadSummaryPill.svelte";

  /**
   * The thread summary: its own element in the thread area's top-right corner, never part of the right panel, and
   * never in the chat column's way. Where it fits beside the chat column (`docked`), the summary follows one choice
   * on this device: a fixed-width card from the top to the bottom of the area (it scrolls inside), or a pill. Elsewhere it is always the pill, and the pill opens the card as a
   * popover under it that closes on Escape, a click outside, a thread change or a resize; the device choice is
   * untouched. Narrow areas open a sheet instead. The card grows from the pill's corner (motion.css `t-summary`).
   */
  let {
    thread,
    tree,
    floating,
    docked,
    children,
  }: {
    thread: ui.Thread;
    tree: ThreadTree | undefined;
    /** The area fits the card as a popover; otherwise the pill opens a sheet. */
    floating: boolean;
    /** The right gutter beside the chat column holds the card. */
    docked: boolean;
    children: Snippet;
  } = $props();

  const id = $props.id();
  let pill = $state<HTMLButtonElement>();
  let card = $state<HTMLElement>();
  let sheet = $state(false);
  let popover = $state(false);
  const pinned = $derived(docked && !device.view.threadPanelCollapsed);
  const open = $derived(pinned || (floating && popover));
  const subagents = $derived(tree?.sides.filter((side) => side.spawnedByAgent).length ?? 0);

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

  // Escape inside the open card closes it, unless an open picker or menu in it handled the key first.
  const escapeCloses: Attachment<HTMLElement> = (node) => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
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

      if (card?.contains(event.target) || pill?.contains(event.target)) return;

      // Pickers and menus opened from the card render in the top layer, outside it.
      if (event.target instanceof Element && event.target.closest(".density-overlay, dialog")) return;
      void hide(false);
    };

    document.addEventListener("pointerdown", pointerdown, true);

    return () => document.removeEventListener("pointerdown", pointerdown, true);
  });
</script>

<div class="pointer-events-none absolute inset-y-3 right-4 z-30 w-80 max-w-[calc(100%-2rem)]">
  <div
    class="t-summary-pill pointer-events-auto absolute top-0 right-0 flex max-w-full justify-end"
    data-hidden={pinned || undefined}
    inert={pinned}
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
  {#if floating}
    <section
      bind:this={card}
      {id}
      aria-label="Thread details"
      class={[
        "t-summary pointer-events-auto absolute right-0 flex w-full flex-col overflow-hidden rounded-xl bg-white ring-1 ring-zinc-950/10 dark:shadow-none",
        pinned
          ? "inset-y-0 shadow-sm dark:bg-zinc-900 dark:ring-white/10"
          : "top-10 max-h-[max(16rem,calc(100%-14rem))] shadow-xl sm:top-9 dark:bg-zinc-800 dark:ring-white/15",
      ]}
      data-hidden={!open || undefined}
      inert={!open}
      {@attach escapeCloses}
    >
      <div
        class="density-chrome flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-950/5 pr-1 pl-3 dark:border-white/8"
      >
        <h2 class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Thread details</h2>
        <span data-summary-collapse class="contents">
          {#if pinned}<IconButton
              icon="chevron-down"
              iconClass="rotate-180"
              label="Collapse thread details"
              aria-expanded="true"
              aria-controls={id}
              onclick={() => void hide(true)}
            />{:else}<IconButton icon="x-mark" label="Close thread details" onclick={() => void hide(true)} />{/if}
        </span>
      </div>
      <div class="min-h-0 scroll-stable-both overflow-y-auto overscroll-contain px-1 pb-1">{@render children()}</div>
    </section>
  {/if}
</div>

{#if !floating}
  <Dialog bind:open={sheet} title="Thread details" sheet>
    {#if sheet}{@render children()}{/if}
  </Dialog>
{/if}
