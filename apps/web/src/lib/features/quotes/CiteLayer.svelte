<script lang="ts">
  import type { Attachment } from "svelte/attachments";
  import { formatHotkey } from "#lib/shared/ui/hotkeys.ts";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import CiteButton from "./CiteButton.svelte";
  import { citePosition } from "./cite-position.ts";
  import { useQuoteDrafts } from "./quote-drafts.svelte.ts";
  import { selectedQuote, type SelectedQuote } from "./selection.ts";
  import SelectionMenu from "./SelectionMenu.svelte";

  /**
   * Cite: select text the agent produced inside `root` (the thread's feed) and a small "Cite" button appears at
   * the end of the selection — after the mouse is released or the keyboard selection settles (with a mouse),
   * or below the selection handles on touch screens, clear of the system's own menu above it. It inserts the
   * citation at the composer's saved caret. Alt+Q cites the current selection from the keyboard.
   * Nothing in the transcript moves: the button lives in
   * the top layer. It stays between the top of `root` and the top of `avoid` (the sticky composer at the bottom of
   * the feed): next to a selection right above the composer it flips above the selection instead of covering it.
   */
  let {
    threadId,
    root,
    avoid,
    beforeinsert,
  }: {
    threadId: string;
    root: HTMLElement | undefined;
    avoid?: HTMLElement | undefined;
    beforeinsert?: () => Promise<void>;
  } = $props();

  const CITE_HOTKEY = $derived(keybindings.get("message:quote")[0] ?? "");
  const drafts = useQuoteDrafts();
  let quote = $state.raw<SelectedQuote>();
  let button = $state<HTMLButtonElement>();
  let touch = $state(false);

  // The selection as it was when it settled, used to position the Cite button.
  let range: Range | undefined;
  let pointerDown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Said to screen readers after a save (the chip appears in the composer). */
  let announced = $state("");

  function read() {
    const selection = getSelection();
    const found = selectedQuote(selection);
    const live = found && selection ? selection.getRangeAt(0) : undefined;

    if (!found || !live || !root?.contains(live.commonAncestorContainer)) {
      quote = undefined;
      range = undefined;

      return;
    }

    range = live.cloneRange();
    quote = found;
    announced = "";
  }

  function schedule(ms: number) {
    clearTimeout(timer);
    timer = setTimeout(read, ms);
  }

  $effect(() => {
    if (!root) return;

    const onselectionchange = () => {
      // While a mouse drags the selection, the button waits for the release.
      if (pointerDown) {
        quote = undefined;

        return;
      }

      schedule(touch ? 250 : 120);
    };

    const onpointerdown = (event: PointerEvent) => {
      touch = event.pointerType === "touch";

      if (event.target instanceof Node && button?.contains(event.target)) return;
      pointerDown = event.pointerType === "mouse";
    };

    const onpointerup = () => {
      if (!pointerDown) return;
      pointerDown = false;
      schedule(0);
    };

    const onkeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (keybindings.matches(event, "message:quote")) {
        if (!quote) read();

        if (!quote) return;
        event.preventDefault();
        cite();
      } else if (event.key === "Escape" && quote) {
        quote = undefined;
      }
    };

    document.addEventListener("selectionchange", onselectionchange);
    document.addEventListener("pointerdown", onpointerdown, true);
    document.addEventListener("pointerup", onpointerup, true);
    document.addEventListener("keydown", onkeydown);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onselectionchange);
      document.removeEventListener("pointerdown", onpointerdown, true);
      document.removeEventListener("pointerup", onpointerup, true);
      document.removeEventListener("keydown", onkeydown);
    };
  });

  /** Keeps the button at the selection's end while the feed scrolls; gone once the selection is off screen. */
  const place: Attachment<HTMLElement> = (node) => {
    node.showPopover();
    let frame = 0;

    const update = () => {
      const rects = [...(range?.getClientRects() ?? [])].filter((r) => r.width > 0 || r.height > 0);
      const backward = quote?.backward ?? false;
      const line = backward ? rects[0] : rects.at(-1);

      // The room: from the top of the feed to the top of what sits over its bottom (the composer).
      const room = {
        top: Math.max(0, root?.getBoundingClientRect().top ?? 0),
        bottom: Math.min(window.innerHeight, avoid?.getBoundingClientRect().top ?? window.innerHeight),
        width: document.documentElement.clientWidth,
      };

      const position = citePosition(line, { width: node.offsetWidth, height: node.offsetHeight }, room, {
        backward,
        touch,
      });

      if (!position) {
        quote = undefined;

        return;
      }

      node.style.setProperty("--float-x", `${position.x}px`);
      node.style.setProperty("--float-y", `${position.y}px`);
    };

    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", later, { capture: true, passive: true });
    window.addEventListener("resize", later, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", later, { capture: true });
      window.removeEventListener("resize", later);
    };
  };

  function cite() {
    if (!quote) return;
    insert(quote);
  }

  async function insert(selected: SelectedQuote) {
    const targetThread = threadId;
    getSelection()?.removeAllRanges();
    await beforeinsert?.();
    const added = drafts.add(targetThread, { text: selected.text, source: selected.source });

    if (added) announced = "Quote added to the message";
    else toast("A message can carry up to 20 quotes", { tone: "error" });
    done();
  }

  function done() {
    quote = undefined;
    range = undefined;
  }
</script>

<SelectionMenu {root} shortcut={CITE_HOTKEY} oncite={insert} />

{#if quote}
  <CiteButton
    bind:element={button}
    {@attach place}
    {@attach tooltip("Quote in your message", { hotkey: CITE_HOTKEY })}
    popover="manual"
    class="t-tt fixed inset-auto top-(--float-y) left-(--float-x) m-0"
    onclick={cite}
  />
{/if}
<p class="sr-only" role="status">
  {quote ? `Selected text can be quoted: ${formatHotkey(CITE_HOTKEY)}` : announced}
</p>
