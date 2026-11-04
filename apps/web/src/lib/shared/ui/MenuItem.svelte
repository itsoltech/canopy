<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import Kbd from "./Kbd.svelte";
  import { hoverFocus, menuIconClasses, menuRowClasses, useMenu } from "./menu.ts";
  import MenuItemText from "./MenuItemText.svelte";

  /**
   * One action of a `DropdownMenu`. Choosing it runs `onselect` and closes the menu (unless
   * `keepOpen`). With `href` it is a link. `shortcut` shows a hint (bind the hotkey yourself).
   *
   *   <MenuItem icon="link" shortcut="Mod+Shift+C" onselect={copyLink}>Copy link</MenuItem>
   */
  let {
    icon,
    href,
    shortcut,
    description,
    disabled = false,
    danger = false,
    keepOpen = false,
    onselect,
    class: className,
    children,
  }: {
    icon?: IconName | undefined;
    href?: string | undefined;
    shortcut?: string | undefined;
    description?: string | undefined;
    disabled?: boolean;
    danger?: boolean;
    keepOpen?: boolean;
    onselect?: (() => void) | undefined;
    class?: ClassValue;
    children: Snippet;
  } = $props();

  const menu = useMenu();

  function choose(event: MouseEvent) {
    if (disabled) {
      event.preventDefault();

      return;
    }

    onselect?.();

    if (!keepOpen) menu.closeAll();
  }

  const onpointermove = hoverFocus(() => (menu.openSub = undefined));
</script>

{#snippet body()}
  {#if icon}
    <Icon name={icon} class={danger ? "h-lh fill-rose-600 dark:fill-rose-400" : menuIconClasses} />
  {/if}
  <MenuItemText {description}>{@render children()}</MenuItemText>
  {#if shortcut}<span class="flex h-lh items-center"><Kbd hotkey={shortcut} /></span>{/if}
{/snippet}

{#if href && !disabled}
  <a
    {href}
    role="menuitem"
    tabindex="-1"
    data-menu-item
    class={[menuRowClasses, danger && "text-rose-700 dark:text-rose-400", className]}
    onclick={choose}
    {onpointermove}
  >
    {@render body()}
  </a>
{:else}
  <button
    type="button"
    role="menuitem"
    tabindex="-1"
    data-menu-item
    aria-disabled={disabled || undefined}
    aria-keyshortcuts={shortcut}
    class={[menuRowClasses, danger && "text-rose-700 dark:text-rose-400", className]}
    onclick={choose}
    {onpointermove}
  >
    {@render body()}
  </button>
{/if}
