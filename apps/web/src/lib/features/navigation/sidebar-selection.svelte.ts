import type { ui } from "@canopy/contracts";
import { getContext, setContext } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { isApple } from "#lib/shared/ui/hotkeys.ts";

const KEY = Symbol("sidebar-selection");

/** Every selectable row link carries its thread id here (SidebarThreadLink): the order the sidebar shows. */
const SELECT_ATTRIBUTE = "data-thread-select";

export const provideSidebarSelection = (selection: SidebarSelection) => setContext(KEY, selection);
export const useSidebarSelection = () => getContext<SidebarSelection | undefined>(KEY);

/** ⌘ on Apple platforms and Ctrl elsewhere toggles one row; Shift selects a range. */
export const selectGesture = (event: MouseEvent): "toggle" | "range" | undefined =>
  event.shiftKey ? "range" : (isApple() ? event.metaKey : event.ctrlKey) ? "toggle" : undefined;

/**
 * Several threads chosen in the sidebar for one action from the row menu. The open thread starts a selection
 * (the first ⌘/Ctrl or Shift click adds it, as in a file manager), Shift extends from the last chosen row in the
 * order the sidebar shows, a plain click on a row or Escape clears it. Rows register themselves so archived and
 * snoozed rows, which the overview may not hold, resolve to their thread too.
 */
export class SidebarSelection {
  readonly ids = new SvelteSet<string>();
  #anchor: string | undefined;
  readonly #rows = new Map<string, () => ui.Thread>();

  constructor(
    private readonly current: () => ui.Thread | undefined,
    private readonly known: (id: string) => ui.Thread | undefined,
  ) {}

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** The row of a thread while it is shown; returns its removal. */
  register(id: string, thread: () => ui.Thread): () => void {
    this.#rows.set(id, thread);

    return () => {
      if (this.#rows.get(id) === thread) this.#rows.delete(id);
    };
  }

  /** Selected threads that still exist, in the order they were chosen. */
  threads(): ui.Thread[] {
    return [...this.ids].flatMap((id) => {
      const thread = this.#rows.get(id)?.() ?? this.known(id);

      return thread && !thread.deletedAt ? [thread] : [];
    });
  }

  /** Applies a ⌘/Ctrl or Shift click on a row link inside `root`. */
  choose(id: string, gesture: "toggle" | "range", root: ParentNode, additive = false): void {
    const order = this.#order(root);
    const current = this.current()?.id;

    // The open thread counts as chosen until a selection exists, when it is on screen.
    const start = this.#anchor ?? (current && order.includes(current) ? current : undefined);

    if (gesture === "toggle") {
      if (!this.ids.size && start && start !== id) this.ids.add(start);

      if (this.ids.has(id)) this.ids.delete(id);
      else this.ids.add(id);
      this.#anchor = this.ids.size ? id : undefined;

      return;
    }

    const from = start ? order.indexOf(start) : -1;
    const to = order.indexOf(id);

    if (!additive) this.ids.clear();

    if (from < 0 || to < 0) this.ids.add(id);
    else for (const each of order.slice(Math.min(from, to), Math.max(from, to) + 1)) this.ids.add(each);
    this.#anchor ??= start ?? id;
  }

  clear(): void {
    this.ids.clear();
    this.#anchor = undefined;
  }

  #order(root: ParentNode): string[] {
    const links = root.querySelectorAll<HTMLElement>(`[${SELECT_ATTRIBUTE}]`);

    return [...new Set([...links].flatMap((link) => link.getAttribute(SELECT_ATTRIBUTE) || []))];
  }
}
