import { maxSidebarWidth, SIDEBAR_WIDTH, sidebarWidthFor } from "@open-agents/domain";
import type { ResizeChange } from "#lib/shared/ui/resize-handle.ts";
import { duration } from "#lib/shared/ui/motion.ts";
import type { SettingsState } from "#lib/features/settings/settings-state.svelte.ts";

/** Id of the desktop sidebar column (the toggle's `aria-controls`). */
export const SIDEBAR_ID = "app-sidebar";
export const SIDEBAR_HOTKEY = "Mod+B";

/** How long after the last change the width and collapse are saved (a drag saves once, when let go). */
const SAVE_DELAY_MS = 400;

/**
 * Width and collapse of the desktop sidebar. Both live in the appearance settings (gateway); while the user
 * changes them the change shows at once as a draft and is saved once things are still. `viewport` (the
 * window's width, browser only) keeps the width under 45% of it; the server renders the same cap in CSS
 * (`cssWidth`), so the first paint already has the right width.
 */
export class SidebarLayout {
  /** The window's width (bound from the root layout). */
  viewport = $state<number | undefined>(undefined);
  /** A ResizeHandle drag is going on. */
  dragging = $state(false);
  /** The column is easing to a new width (toggle, reset, snap), motion.css `t-sidebar[data-settling]`. */
  settling = $state(false);
  #width = $state<number | undefined>(undefined);
  #collapsed = $state<boolean | undefined>(undefined);
  #pending: { sidebarWidth?: number; sidebarCollapsed?: boolean } = {};
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #settleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #settings: SettingsState;

  constructor(settings: SettingsState) {
    this.#settings = settings;
  }

  get collapsed(): boolean {
    return this.#collapsed ?? this.#settings.appearance.sidebarCollapsed;
  }

  /** The saved (or drafted) width, before the window's cap; 0 = default. */
  get #saved(): number {
    return this.#width ?? this.#settings.appearance.sidebarWidth;
  }

  /** The width the sidebar has when open, px. */
  get width(): number {
    const saved = this.#saved;
    return this.viewport === undefined ? saved || SIDEBAR_WIDTH.default : sidebarWidthFor(saved, this.viewport);
  }

  get maxWidth(): number {
    return this.viewport === undefined ? SIDEBAR_WIDTH.max : maxSidebarWidth(this.viewport);
  }

  /** `--sidebar-width`: the width capped by the window in CSS too (right on the server's first paint). */
  get cssWidth(): string {
    const width = this.#saved || SIDEBAR_WIDTH.default;
    return `clamp(${SIDEBAR_WIDTH.min}px, ${width}px, max(${SIDEBAR_WIDTH.min}px, ${SIDEBAR_WIDTH.viewportShare * 100}vw))`;
  }

  /** Live, while dragging: the column follows (a snap to collapsed and back eases). */
  resize(size: number, collapsed: boolean): void {
    if (collapsed !== this.collapsed) this.#settle();
    this.#width = size;
    this.#collapsed = collapsed;
  }

  /** A finished drag, key or reset of the handle. */
  change({ size, collapsed, reason }: ResizeChange): void {
    if (reason === "reset" || collapsed !== this.collapsed) this.#settle();
    this.#width = size;
    this.#collapsed = collapsed;
    this.#save(collapsed ? { sidebarCollapsed: true } : { sidebarWidth: reason === "reset" ? 0 : size, sidebarCollapsed: false });
  }

  toggle(): void {
    this.setCollapsed(!this.collapsed);
  }

  /** Focus inside a collapsing sidebar moves to the toggle (the sidebar becomes inert). */
  setCollapsed(collapsed: boolean): void {
    if (collapsed === this.collapsed) return;
    if (collapsed && document.getElementById(SIDEBAR_ID)?.contains(document.activeElement)) {
      [...document.querySelectorAll<HTMLElement>("[data-sidebar-toggle]")].find((toggle) => toggle.checkVisibility())?.focus();
    }
    this.#settle();
    this.#collapsed = collapsed;
    this.#save({ sidebarCollapsed: collapsed });
  }

  /** Saves what is pending now (leaving the page). */
  flush(): void {
    clearTimeout(this.#saveTimer);
    const change = this.#pending;
    this.#pending = {};
    if (Object.keys(change).length === 0) return;
    // The settings show the change at once, so the drafts can go.
    void this.#settings.updateAppearance(change).catch(() => undefined);
    this.#width = undefined;
    this.#collapsed = undefined;
  }

  #save(change: { sidebarWidth?: number; sidebarCollapsed?: boolean }): void {
    this.#pending = { ...this.#pending, ...change };
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  #settle(): void {
    this.settling = true;
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => (this.settling = false), duration("slow") + 50);
  }
}
