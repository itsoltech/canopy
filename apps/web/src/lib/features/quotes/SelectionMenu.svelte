<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { selectedQuote, type SelectedQuote } from "./selection.ts";

  let {
    root,
    shortcut,
    oncite,
    class: className,
  }: {
    root: HTMLElement | undefined;
    shortcut: string;
    oncite: (quote: SelectedQuote) => void;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
  let selected = $state.raw<SelectedQuote>();
  let point = $state({ x: 0, y: 0 });

  $effect(() => {
    const node = root;

    if (!node) return;

    const contextmenu = (event: MouseEvent) => {
      // Touch keeps the system's selection handles and menu; its floating Cite action remains available.
      if (matchMedia("(pointer: coarse)").matches) return;
      const selection = getSelection();
      const quote = selectedQuote(selection);
      const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;

      if (!quote || !range || !node.contains(range.commonAncestorContainer)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = range.getBoundingClientRect();
      point =
        event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom };
      selected = quote;
      open = true;
    };

    node.addEventListener("contextmenu", contextmenu, true);

    return () => node.removeEventListener("contextmenu", contextmenu, true);
  });

  async function copy() {
    if (!selected) return;

    try {
      await navigator.clipboard.writeText(selected.text);
      toast("Copied");
    } catch {
      toast("Could not copy the text. Select it and try again.", { tone: "error" });
    }
  }
</script>

<DropdownMenu bind:open label="Selected text actions" class={className}>
  {#snippet trigger(props)}
    <span
      {...anchorOnly(props)}
      aria-hidden="true"
      class="pointer-events-none fixed size-px"
      style:left="{point.x}px"
      style:top="{point.y}px"
    ></span>
  {/snippet}
  <MenuItem icon="chat-bubble-bottom-center-text" {shortcut} onselect={() => selected && oncite(selected)}
    >Cite</MenuItem
  >
  <MenuItem icon="copy" onselect={() => void copy()}>Copy text</MenuItem>
</DropdownMenu>
