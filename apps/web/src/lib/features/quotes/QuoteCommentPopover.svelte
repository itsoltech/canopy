<script lang="ts">
  import { QUOTE_LIMITS } from "@canopy/domain";
  import Button from "#lib/shared/ui/Button.svelte";
  import { focusables, type Placement } from "#lib/shared/ui/floating.ts";
  import type { ClassValue } from "svelte/elements";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { quoteLabel } from "./quote.ts";

  /**
   * The comment on a quote, next to `anchor` (the Cite button, later a quote chip's pencil): "Add an optional
   * comment…" with Cancel and Save. Enter saves (Shift+Enter is a new line), Escape or a click outside cancels;
   * an empty comment saves too. Tab stays inside while it is open. It grows from its anchor (Popover, `t-dropdown`).
   */
  let {
    open = $bindable(false),
    anchor,
    quote,
    comment = "",
    placement = "bottom-start",
    onsave,
    oncancel,
    onclosed,
    class: className,
  }: {
    open?: boolean;
    anchor: HTMLElement | undefined;
    /** The quoted text: its beginning names what the comment is about. */
    quote: string;
    /** The comment so far (editing a quote). */
    comment?: string;
    placement?: Placement;
    onsave: (comment: string) => void;
    oncancel?: (() => void) | undefined;
    /** After it closed either way (its exit motion finished). */
    onclosed?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  let draft = $state("");
  let saved = false;

  $effect(() => {
    if (open) {
      draft = comment;
      saved = false;
    }
  });

  function save() {
    saved = true;
    onsave(draft.trim());
    open = false;
  }

  function onclose() {
    if (!saved) oncancel?.();
    onclosed?.();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      save();
    }
  }

  // Tab and Shift+Tab go round the panel's controls.
  function trap(event: KeyboardEvent) {
    if (event.key !== "Tab") return;
    const panel = (event.currentTarget as HTMLElement | null) ?? undefined;
    const items = panel ? focusables(panel) : [];
    const first = items[0];
    const last = items.at(-1);

    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<Popover
  bind:open
  label="Comment on the quote"
  {anchor}
  {placement}
  panelKeydown={trap}
  {onclose}
  class={["w-80 max-w-[calc(100vw-1rem)]", className]}
>
  <form
    class="grid gap-3 p-3"
    onsubmit={(event) => {
      event.preventDefault();
      save();
    }}
  >
    <p class="truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">“{quoteLabel(quote, 60)}”</p>
    <Textarea
      name="comment"
      aria-label="Comment on the quote"
      placeholder="Add an optional comment…"
      rows={2}
      maxlength={QUOTE_LIMITS.maxCommentChars}
      data-autofocus
      bind:value={draft}
      {onkeydown}
      resize={false}
      class="field-sizing-content max-h-40 min-h-16"
    />
    <div class="flex justify-end gap-2">
      <Button size="sm" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
      <Button size="sm" variant="primary" type="submit">Save</Button>
    </div>
  </form>
</Popover>
