<script lang="ts" module>
  /** Look shared by every row of a menu (items, check items, submenu triggers). */
  export const menuRowClasses =
    "group/item relative flex w-full cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-base/6 text-zinc-800 outline-none select-none focus:bg-zinc-950/5 focus:text-zinc-950 aria-disabled:opacity-50 aria-expanded:bg-zinc-950/5 sm:py-1.5 sm:text-sm/5 dark:text-zinc-200 dark:focus:bg-white/8 dark:focus:text-white dark:aria-expanded:bg-white/8";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import Kbd from "./Kbd.svelte";
  import { useMenu } from "./menu.ts";

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
  // Hovering moves the roving focus (and closes a sibling's submenu), like native menus.
  function onpointermove(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    menu.openSub = undefined;
    const item = event.currentTarget as HTMLElement;
    if (document.activeElement !== item) item.focus({ preventScroll: true });
  }
</script>

{#snippet body()}
  {#if icon}
    <Icon name={icon} class={["h-lh", danger ? "fill-rose-600 dark:fill-rose-400" : "fill-zinc-500 group-focus/item:fill-zinc-700 dark:fill-zinc-400 dark:group-focus/item:fill-zinc-200"]} />
  {/if}
  <span class="grid min-w-0 flex-1">
    <span class="truncate">{@render children()}</span>
    {#if description}<span class="text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{description}</span>{/if}
  </span>
  {#if shortcut}<span class="flex h-lh items-center"><Kbd hotkey={shortcut} /></span>{/if}
{/snippet}

{#if href && !disabled}
  <a {href} role="menuitem" tabindex="-1" data-menu-item class={[menuRowClasses, danger && "text-rose-700 dark:text-rose-400", className]} onclick={choose} {onpointermove}>
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
