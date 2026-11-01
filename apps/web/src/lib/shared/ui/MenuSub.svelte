<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import { focusItem, menuKeydown, provideMenu, useMenu } from "./menu.ts";
  import { menuRowClasses } from "./MenuItem.svelte";
  import Popover from "./Popover.svelte";

  /**
   * Submenu of a `DropdownMenu`: opens to the side on hover, click, ArrowRight or Enter; ArrowLeft or
   * Escape goes back to its row. Choosing an item inside closes the whole menu.
   *
   *   <MenuSub label="Copy" icon="document-duplicate"><MenuItem onselect={copyId}>Thread ID</MenuItem></MenuSub>
   */
  let { label, icon, children }: { label: string; icon?: IconName | undefined; children: Snippet } = $props();

  const id = $props.id();
  const parent = useMenu();
  const menu = $state({ openSub: undefined as string | undefined, closeAll: () => parent.closeAll() });
  provideMenu(menu);

  const open = $derived(parent.openSub === id);
  // Only a keyboard opening moves focus into the submenu; hovering keeps it on the row.
  let byKeyboard = $state(false);

  function triggerKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      byKeyboard = true;
      parent.openSub = id;
    }
  }
  function panelKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      parent.openSub = undefined;
    }
  }
  function onpointermove(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    const row = event.currentTarget as HTMLElement;
    if (document.activeElement !== row) row.focus({ preventScroll: true });
    if (!open) {
      byKeyboard = false;
      parent.openSub = id;
    }
  }
  const navigate = menuKeydown();
</script>

<Popover
  bind:open={() => open, (value) => (parent.openSub = value ? id : undefined)}
  {label}
  placement="right-start"
  offset={2}
  role="menu"
  focusOnOpen={byKeyboard}
  initialFocus={(panel) => focusItem(panel, "first")}
  {triggerKeydown}
  panelKeydown={(event) => {
    panelKeydown(event);
    if (!event.defaultPrevented) navigate(event);
  }}
  onclose={() => (menu.openSub = undefined)}
  class="min-w-44 p-1"
>
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      role="menuitem"
      tabindex="-1"
      data-menu-item
      class={menuRowClasses}
      onclick={() => {
        byKeyboard = false;
        parent.openSub = open ? undefined : id;
      }}
      {onpointermove}
    >
      {#if icon}<Icon name={icon} class="h-lh fill-zinc-500 group-focus/item:fill-zinc-700 dark:fill-zinc-400 dark:group-focus/item:fill-zinc-200" />{/if}
      <span class="min-w-0 flex-1 truncate">{label}</span>
      <Icon name="chevron-right" class="h-lh fill-zinc-400 dark:fill-zinc-500" />
    </button>
  {/snippet}
  {@render children()}
</Popover>
