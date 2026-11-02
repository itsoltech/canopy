<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { tick } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { carriesMore, messageOf, overrides, ownMessage, queuedText, steerable } from "./queue.ts";
  import QueueEditor from "./QueueEditor.svelte";
  import QueueHandle from "./QueueHandle.svelte";
  import QueueRowMenu from "./QueueRowMenu.svelte";

  /**
   * One queued message: its handle (the queue icon; the grip on hover or focus, always on touch), the text on
   * one line, what it overrides, and its actions — Steer (into the running turn now), delete, and "…". Drag the
   * handle to reorder, or press Alt+↑/↓ anywhere in the row (↑/↓ on the handle). While dragged the row lifts and
   * follows the pointer (`offset`); released, it eases into its slot.
   */
  let {
    turn,
    index,
    count,
    running,
    fallback,
    editing,
    dragging,
    offset,
    delivery,
    onmove,
    ondragstart,
    onsteer,
    ondelete,
    onedit,
    onsave,
    oncancel,
    ondelivery,
    class: className,
  }: {
    turn: ui.Turn;
    index: number;
    count: number;
    running: boolean;
    /** The steer that could not join the running turn: this message runs at its place instead. */
    fallback: ui.Steer | undefined;
    editing: boolean;
    dragging: boolean;
    offset: number;
    delivery: "steer" | "queue";
    onmove: (index: number) => void;
    ondragstart: (event: PointerEvent) => void;
    onsteer: () => void;
    ondelete: () => void;
    onedit: () => void;
    onsave: (text: string) => Promise<string | undefined>;
    oncancel: () => void;
    ondelivery: (delivery: "steer" | "queue") => void;
    class?: ClassValue;
  } = $props();

  const text = $derived(queuedText(turn));
  const hints = $derived(overrides(turn));
  const own = $derived(ownMessage(turn));
  let handle = $state<HTMLButtonElement>();

  /** Moves the row and keeps the focus on its handle (the row's element moves in the list). */
  function move(to: number) {
    if (to < 0 || to >= count || to === index) return;
    onmove(to);
    void tick().then(() => handle?.focus());
  }

  function onkeydown(event: KeyboardEvent) {
    if (editing || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    // ↑/↓ alone on the handle; Alt+↑/↓ anywhere in the row.
    if (!event.altKey && event.target !== handle) return;
    event.preventDefault();
    move(index + (event.key === "ArrowUp" ? -1 : 1));
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (keys bubble from the row's buttons) -->
<div
  class={[
    "group/row relative rounded-xl",
    dragging
      ? "z-10 cursor-grabbing bg-white shadow-md ring-1 ring-zinc-950/10 dark:bg-zinc-800 dark:shadow-none dark:ring-white/10"
      : "transition-[translate] duration-(--duration-fast) ease-smooth-out",
    className,
  ]}
  style:translate={dragging ? `0 ${offset}px` : undefined}
  {onkeydown}
>
  {#if editing}
    <QueueEditor text={messageOf(turn)} allowEmpty={carriesMore(turn)} {onsave} {oncancel} />
  {:else}
    <div class="flex min-h-9 items-center gap-1 px-3 py-0.5">
      <QueueHandle label={text} bind:element={handle} {ondragstart} />
      <p class="min-w-0 flex-1 truncate text-sm/5 text-zinc-700 sm:text-[0.8125rem]/5 dark:text-zinc-300" title={text}>
        {text || (turn.attachments.length > 0 ? "(only files)" : "(only quotes)")}
      </p>
      {#if fallback}
        <span class="flex shrink-0" {@attach tooltip(`Could not join the running turn${fallback.reason ? ` (${fallback.reason})` : ""}; it runs at its place in the queue.`)}>
          <Icon name="exclamation-circle" class="fill-amber-500" label="Could not join the running turn" />
        </span>
      {/if}
      {#if hints.length > 0}
        <p class="max-w-48 shrink-0 truncate text-xs/6 text-zinc-500 max-sm:hidden dark:text-zinc-400" title="Runs with {hints.join(', ')}">{hints.join(" · ")}</p>
      {/if}
      {#if own && running}
        {@const files = !steerable(turn)}
        <span class="flex shrink-0" {@attach tooltip(files ? "A message with files runs as its own turn" : "Send it into the running turn now")}>
          <Button variant="ghost" size="sm" icon="arrow-turn-down-right" disabled={files} onclick={onsteer}><span class="max-sm:sr-only">Steer</span></Button>
        </span>
      {/if}
      {#if own}
        <IconButton icon="trash" label="Delete" size="sm" onclick={ondelete} />
      {/if}
      <QueueRowMenu {index} {count} {hints} {delivery} onedit={own ? onedit : undefined} onmove={move} {ondelivery} />
    </div>
  {/if}
</div>
