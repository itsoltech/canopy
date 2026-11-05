<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import {
    focusItem,
    hoverFocus,
    menuGlyphClasses,
    menuIconClasses,
    menuKeydown,
    menuRowClasses,
    provideMenu,
    useMenu,
    type MenuContext,
  } from "./menu.ts";
  import Popover from "./Popover.svelte";

  /**
   * Submenu of a `DropdownMenu`: opens to the side on hover, click, ArrowRight or Enter; ArrowLeft or
   * Escape goes back to its row. Choosing an item inside closes the whole menu.
   *
   *   <MenuSub label="Copy" icon="document-duplicate"><MenuItem onselect={copyId}>Thread ID</MenuItem></MenuSub>
   */
  let {
    label,
    icon,
    class: className,
    children,
  }: { label: string; icon?: IconName | undefined; class?: ClassValue; children: Snippet } = $props();

  const id = $props.id();
  const parent = useMenu();
  const menu = $state<MenuContext>({ openSub: undefined, closeAll: () => parent.closeAll() });

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

  const onpointermove = hoverFocus(() => {
    if (open) return;
    byKeyboard = false;
    parent.openSub = id;
  });

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
      class={[menuRowClasses, className]}
      onclick={() => {
        byKeyboard = false;
        parent.openSub = open ? undefined : id;
      }}
      {onpointermove}
    >
      {#if icon}<span class={menuGlyphClasses}><Icon name={icon} class={menuIconClasses} /></span>{/if}
      <span class="min-w-0 flex-1 truncate">{label}</span>
      <span class={menuGlyphClasses}><Icon name="chevron-right" class="fill-zinc-400 dark:fill-zinc-500" /></span>
    </button>
  {/snippet}
  {@render children()}
</Popover>
