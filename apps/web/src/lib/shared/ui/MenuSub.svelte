<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import {
    focusItem,
    hoverFocus,
    menuControlClasses,
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
   * Escape goes back to its row. With a primary action, the label runs it and the chevron opens
   * the choices. ArrowRight opens the choices from either button.
   *
   *   <MenuSub label="Copy" icon="document-duplicate"><MenuItem onselect={copyId}>Thread ID</MenuItem></MenuSub>
   */
  let {
    label,
    icon,
    primary,
    disabled = false,
    class: className,
    children,
  }: {
    label: string;
    icon?: IconName | undefined;
    primary?: { label: string; onselect: () => void };
    disabled?: boolean | undefined;
    class?: ClassValue;
    children: Snippet;
  } = $props();

  const id = $props.id();
  const parent = useMenu();
  const menu = $state<MenuContext>({ openSub: undefined, closeAll: () => parent.closeAll() });

  provideMenu(menu);

  const open = $derived(!disabled && parent.openSub === id);
  let row = $state<HTMLDivElement>();
  const splitControlClasses = `${menuControlClasses} focus-visible:outline-solid`;

  function triggerKeydown(event: KeyboardEvent, panelId: string) {
    if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();

      if (disabled) return;
      parent.openSub = id;
      void tick().then(() => {
        const panel = document.getElementById(panelId);

        if (open && panel) focusItem(panel, "first");
      });
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
    parent.openSub = disabled ? undefined : id;
  });

  const navigate = menuKeydown();
</script>

<Popover
  bind:open={() => open, (value) => (parent.openSub = value ? id : undefined)}
  {label}
  anchor={primary ? row : undefined}
  placement="right-start"
  offset={2}
  role="menu"
  focusOnOpen={false}
  panelKeydown={(event) => {
    panelKeydown(event);
    if (!event.defaultPrevented) navigate(event);
  }}
  onclose={() => (menu.openSub = undefined)}
  class="min-w-44 p-1"
>
  {#snippet trigger(props)}
    <div
      bind:this={row}
      class={primary
        ? "flex rounded-lg focus-within:bg-zinc-950/5 has-aria-expanded:bg-zinc-950/5 dark:focus-within:bg-white/8 dark:has-aria-expanded:bg-white/8"
        : "contents"}
    >
      {#if primary}
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          data-menu-item
          aria-disabled={disabled || undefined}
          class={[splitControlClasses, "min-w-0 flex-1", className]}
          onclick={() => {
            if (disabled) return;
            primary.onselect();
            parent.closeAll();
          }}
          onkeydown={(event) => {
            if (event.key === "ArrowRight") triggerKeydown(event, props["aria-controls"]);
          }}
          {onpointermove}
        >
          {#if icon}<span class={menuGlyphClasses}><Icon name={icon} class={menuIconClasses} /></span>{/if}
          <span class="min-w-0 truncate">{primary.label}</span>
        </button>
      {/if}
      <button
        type="button"
        {...props}
        role="menuitem"
        tabindex="-1"
        data-menu-item
        aria-label={primary ? label : undefined}
        aria-disabled={disabled || undefined}
        class={[
          primary ? splitControlClasses : menuRowClasses,
          primary && "shrink-0 basis-8 justify-center pointer-coarse:basis-11",
          className,
        ]}
        onclick={() => {
          if (!disabled) parent.openSub = open && !primary ? undefined : id;
        }}
        onkeydown={(event) => triggerKeydown(event, props["aria-controls"])}
        {onpointermove}
      >
        {#if !primary}
          {#if icon}<span class={menuGlyphClasses}><Icon name={icon} class={menuIconClasses} /></span>{/if}
          <span class="min-w-0 flex-1 truncate">{label}</span>
        {/if}
        <span class={menuGlyphClasses}><Icon name="chevron-right" class="fill-zinc-400 dark:fill-zinc-500" /></span>
      </button>
    </div>
  {/snippet}
  {@render children()}
</Popover>
