import { getContext, setContext } from "svelte";

/**
 * Shared behaviour of `DropdownMenu` and its items: the menu a item belongs to (to close the whole
 * tree after a choice, and which submenu is open), and keyboard navigation over a menu panel —
 * arrows, Home/End and typeahead move a roving focus between its own items (not a submenu's).
 */
export interface MenuContext {
  /** Close every menu of the tree (after a choice). */
  readonly closeAll: () => void;
  /** Id of the open submenu at this level. */
  openSub: string | undefined;
}

const KEY = Symbol("menu");
export const provideMenu = (menu: MenuContext) => setContext(KEY, menu);
export function useMenu(): MenuContext {
  const menu = getContext<MenuContext | undefined>(KEY);
  if (!menu) throw new Error("Menu items belong inside a DropdownMenu");
  return menu;
}

/** Look shared by every row of a menu (items, check items, submenu triggers). */
export const menuRowClasses =
  "group/item relative flex w-full cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-base/6 text-zinc-800 outline-none select-none focus:bg-zinc-950/5 focus:text-zinc-950 aria-disabled:opacity-50 aria-expanded:bg-zinc-950/5 sm:py-1.5 sm:text-sm/5 dark:text-zinc-200 dark:focus:bg-white/8 dark:focus:text-white dark:aria-expanded:bg-white/8";

/** Leading icon of a menu row. */
export const menuIconClasses = "h-lh fill-zinc-500 group-focus/item:fill-zinc-700 dark:fill-zinc-400 dark:group-focus/item:fill-zinc-200";

/**
 * Pointer handler of a row: hovering with a mouse moves the roving focus to it, like native menus.
 * `onhover` runs too (rows close a sibling's submenu, submenu rows open theirs).
 */
export function hoverFocus(onhover: () => void): (event: PointerEvent) => void {
  return (event) => {
    if (event.pointerType !== "mouse") return;
    const row = event.currentTarget as HTMLElement;
    if (document.activeElement !== row) row.focus({ preventScroll: true });
    onhover();
  };
}

const ITEM = "[data-menu-item]:not([aria-disabled='true'])";

/** Enabled items of `panel` itself, in order (items of nested submenus excluded). */
export function menuItems(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(ITEM)].filter((item) => item.closest("[data-menu-panel]") === panel);
}

export function focusItem(panel: HTMLElement, which: "first" | "last"): boolean {
  const items = menuItems(panel);
  const item = which === "first" ? items[0] : items.at(-1);
  item?.focus({ preventScroll: false });
  return Boolean(item);
}

/** Keyboard navigation inside one menu panel; returns a keydown handler with its own typeahead buffer. */
export function menuKeydown(): (event: KeyboardEvent) => void {
  let typed = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (event) => {
    const panel = event.currentTarget as HTMLElement;
    const items = menuItems(panel);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    // Keys pressed inside a submenu are handled by the submenu's panel.
    if ((event.target as HTMLElement).closest("[data-menu-panel]") !== panel) return;
    switch (event.key) {
      case "ArrowDown":
        return move(current + 1);
      case "ArrowUp":
        return move(current < 0 ? -1 : current - 1);
      case "Home":
        return move(0);
      case "End":
        return move(-1);
      case "Tab":
        // Leaving the menu closes it (focusout does that); keep the browser's tab order.
        return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      clearTimeout(timer);
      typed += event.key.toLowerCase();
      timer = setTimeout(() => (typed = ""), 500);
      if (event.key === " " && typed === " ") {
        typed = "";
        return; // Space activates the focused item.
      }
      event.preventDefault();
      // Same letter again cycles through items starting with it; otherwise match the typed prefix.
      const repeat = [...typed].every((c) => c === typed[0]);
      const prefix = repeat ? typed[0]! : typed;
      const start = repeat ? current + 1 : Math.max(current, 0);
      const ordered = [...items.slice(start), ...items.slice(0, start)];
      ordered.find((item) => (item.dataset.text ?? item.textContent ?? "").trim().toLowerCase().startsWith(prefix))?.focus();
    }
  };
}
