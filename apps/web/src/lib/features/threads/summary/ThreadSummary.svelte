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
   * The thread summary: its own element in the thread area's top-right corner, never part of the right panel.
   * A fixed-width card that collapses to a pill (one choice on this device, for every thread), so it keeps its
   * width and place across threads and panel changes. The card grows from the pill and shrinks back into it
   * (motion.css `t-summary`). Where the area is too narrow for a floating card, the pill opens a sheet.
   */
  let {
    thread,
    tree,
    floating,
    overlay,
    children,
  }: {
    thread: ui.Thread;
    tree: ThreadTree | undefined;
    /** The area fits a floating card; otherwise the pill opens a sheet. */
    floating: boolean;
    /** The card stands over the conversation (the chat column does not fit beside it). */
    overlay: boolean;
    children: Snippet;
  } = $props();

  const id = $props.id();
  let pill = $state<HTMLButtonElement>();
  let card = $state<HTMLElement>();
  let sheet = $state(false);
  const expanded = $derived(floating && !device.view.threadPanelCollapsed);
  const subagents = $derived(tree?.sides.filter((side) => side.spawnedByAgent).length ?? 0);

  $effect(() => {
    if (floating) sheet = false;
  });

  async function open() {
    if (!floating) {
      sheet = true;

      return;
    }

    device.setView({ threadPanelCollapsed: false });
    await tick();
    card?.querySelector<HTMLElement>("[data-summary-collapse] button")?.focus();
  }

  // Escape inside the open card collapses it, unless an open picker or menu in it handled the key first.
  const escapeCollapses: Attachment<HTMLElement> = (node) => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      void collapse();
    };

    node.addEventListener("keydown", keydown);

    return () => node.removeEventListener("keydown", keydown);
  };

  async function collapse() {
    const focused = card?.contains(document.activeElement);
    device.setView({ threadPanelCollapsed: true });
    await tick();

    if (focused) pill?.focus();
  }
</script>

<div class="pointer-events-none absolute inset-y-3 right-4 z-30 w-80 max-w-[calc(100%-2rem)]">
  <div
    class="t-summary-pill pointer-events-auto absolute top-0 right-0 flex max-w-full justify-end"
    data-hidden={expanded || undefined}
    inert={expanded}
  >
    <ThreadSummaryPill
      {thread}
      {subagents}
      {expanded}
      controls={floating ? id : undefined}
      onopen={() => void open()}
      bind:pill
    />
  </div>
  {#if floating}
    <section
      bind:this={card}
      {id}
      aria-label="Thread details"
      class={[
        "t-summary pointer-events-auto absolute top-0 right-0 flex w-full flex-col overflow-hidden rounded-xl bg-white ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:shadow-none dark:ring-white/10",
        overlay ? "max-h-[calc(100%-13rem)] shadow-lg" : "max-h-full shadow-sm",
      ]}
      data-hidden={!expanded || undefined}
      inert={!expanded}
      {@attach escapeCollapses}
    >
      <div
        class="density-chrome flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-950/5 pr-1 pl-3 dark:border-white/8"
      >
        <h2 class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Thread details</h2>
        <span data-summary-collapse class="contents">
          <IconButton
            icon="chevron-down"
            iconClass="rotate-180"
            label="Collapse thread details"
            aria-expanded="true"
            aria-controls={id}
            onclick={() => void collapse()}
          />
        </span>
      </div>
      <div class="min-h-0 scroll-stable-both overflow-y-auto px-1 pb-1">{@render children()}</div>
    </section>
  {/if}
</div>

{#if !floating}
  <Dialog bind:open={sheet} title="Thread details" sheet>
    {#if sheet}{@render children()}{/if}
  </Dialog>
{/if}
