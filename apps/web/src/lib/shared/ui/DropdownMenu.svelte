<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { Placement } from "./floating.ts";
  import { focusItem, menuKeydown, provideMenu } from "./menu.ts";
  import Popover, { type PopoverTriggerProps } from "./Popover.svelte";

  /**
   * Menu of actions or choices (WAI-ARIA menu button). Arrows, Home/End and typeahead move between
   * items, Enter/Space choose, Escape or a click outside closes, focus returns to the trigger.
   * ArrowDown/Enter/Space on the trigger open it on the first item, ArrowUp on the last.
   *
   *   <DropdownMenu label="Thread actions" placement="bottom-end">
   *     {#snippet trigger(props)}<IconButton icon="ellipsis-horizontal" label="Thread actions" {...props} />{/snippet}
   *     <MenuGroup label="Thread">
   *       <MenuItem icon="arrows-right-left" onselect={openSide}>New side thread</MenuItem>
   *     </MenuGroup>
   *     <MenuSeparator />
   *     <MenuCheckItem type="radio" checked={mode === "ASK"} onselect={() => (mode = "ASK")}>Ask first</MenuCheckItem>
   *     <MenuSub label="Copy" icon="document-duplicate">…items…</MenuSub>
   *   </DropdownMenu>
   */
  let {
    open = $bindable(false),
    label,
    placement = "bottom-start",
    sheet = false,
    class: className,
    trigger,
    children,
  }: {
    open?: boolean;
    label: string;
    placement?: Placement;
    /** A bottom sheet on phones (menus of touch-first controls). */
    sheet?: boolean;
    class?: ClassValue;
    trigger: Snippet<[PopoverTriggerProps]>;
    children: Snippet;
  } = $props();

  let start = $state<"first" | "last">("first");

  const menu = $state({
    openSub: undefined as string | undefined,
    closeAll: () => (open = false),
  });

  provideMenu(menu);

  $effect(() => {
    if (!open) menu.openSub = undefined;
  });

  const navigate = menuKeydown();

  function triggerKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      start = event.key === "ArrowUp" ? "last" : "first";
      open = true;
    } else if (event.key === "Enter" || event.key === " ") {
      start = "first";
    }
  }
</script>

<Popover
  bind:open
  {label}
  {placement}
  {sheet}
  role="menu"
  {triggerKeydown}
  panelKeydown={navigate}
  initialFocus={(panel) => {
    const done = focusItem(panel, start);
    start = "first";
    return done;
  }}
  class={["min-w-48 p-1", className]}
  {trigger}
>
  {@render children()}
</Popover>
