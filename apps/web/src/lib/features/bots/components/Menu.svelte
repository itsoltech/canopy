<script lang="ts" module>
  import type { IconName } from "#lib/shared/ui/icons.ts";

  export interface MenuItem {
    label: string;
    icon?: IconName | undefined;
    onselect: () => void;
    disabled?: boolean | undefined;
  }

  /** Spread onto the element that opens the menu. */
  export interface MenuTriggerProps {
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
    onclick: (event: MouseEvent) => void;
    onkeydown: (event: KeyboardEvent) => void;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /**
   * Small action menu in the top layer (native popover, so scrolling lists do not clip it), placed
   * under its trigger and flipped above when there is no room. Arrow keys, Home/End, Escape and Tab
   * work as in a menu button; a click outside, scrolling or resizing closes it. `open` is bindable so
   * a context menu or long press can open it too.
   * Local stand-in until the shared kit's DropdownMenu lands; swap it there.
   */
  let {
    items,
    label,
    open = $bindable(false),
    align = "end",
    trigger,
    class: className,
  }: { items: readonly MenuItem[]; label: string; open?: boolean; align?: "start" | "end"; trigger: Snippet<[MenuTriggerProps]>; class?: ClassValue } = $props();

  const id = $props.id();
  let root = $state<HTMLElement>();
  let menu = $state<HTMLElement>();
  let top = $state(0);
  let left = $state(0);

  const buttons = () => [...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];

  function place() {
    if (!root || !menu) return;
    const anchor = root.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    const below = anchor.bottom + 4;
    top = below + height > innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : below;
    left = Math.min(Math.max(8, align === "end" ? anchor.right - width : anchor.left), innerWidth - width - 8);
  }

  function close(refocus: boolean) {
    open = false;
    if (refocus) root?.querySelector<HTMLElement>("a[href], button")?.focus();
  }

  $effect(() => {
    if (!menu) return;
    if (!open) {
      if (menu.matches(":popover-open")) menu.hidePopover();
      return;
    }
    menu.showPopover();
    place();
    buttons()[0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node) && !menu?.contains(event.target as Node)) close(false);
    };
    const dismiss = (event: Event) => {
      if (!menu?.contains(event.target as Node)) close(false);
    };
    addEventListener("pointerdown", outside, true);
    addEventListener("scroll", dismiss, true);
    addEventListener("resize", dismiss);
    return () => {
      removeEventListener("pointerdown", outside, true);
      removeEventListener("scroll", dismiss, true);
      removeEventListener("resize", dismiss);
    };
  });

  const triggerProps: MenuTriggerProps = {
    "aria-haspopup": "menu",
    get "aria-expanded"() {
      return open;
    },
    "aria-controls": `${id}-menu`,
    onclick: (event) => {
      event.preventDefault();
      open = !open;
    },
    onkeydown: (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open = true;
      }
    },
  };

  function onkeydown(event: KeyboardEvent) {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") close(true);
    else if (event.key === "Tab") return close(false);
    else return;
    event.preventDefault();
  }
</script>

<span bind:this={root} class={["inline-flex", className]}>
  {@render trigger(triggerProps)}
</span>
<div
  bind:this={menu}
  id="{id}-menu"
  popover="manual"
  role="menu"
  aria-label={label}
  tabindex="-1"
  style:--menu-top="{top}px"
  style:--menu-left="{left}px"
  class="fixed inset-auto top-(--menu-top) left-(--menu-left) m-0 min-w-44 rounded-xl bg-white p-1 shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:shadow-none dark:ring-white/10"
  {onkeydown}
>
  {#each items as item (item.label)}
    <button
      type="button"
      role="menuitem"
      tabindex="-1"
      disabled={item.disabled}
      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-base/6 text-zinc-800 focus:bg-zinc-950/5 focus:outline-none not-disabled:hover:bg-zinc-950/5 disabled:opacity-50 sm:py-1.5 sm:text-sm/6 dark:text-zinc-200 dark:focus:bg-white/10 dark:not-disabled:hover:bg-white/10"
      onclick={() => {
        close(true);
        item.onselect();
      }}
    >
      {#if item.icon}<Icon name={item.icon} class="fill-zinc-500 dark:fill-zinc-400" />{/if}
      {item.label}
    </button>
  {/each}
</div>
