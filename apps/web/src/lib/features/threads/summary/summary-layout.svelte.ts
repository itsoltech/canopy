import type { Attachment } from "svelte/attachments";
import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";

/** The chat column never gets narrower than this to make room for the docked summary. */
const MIN_COLUMN_REM = 36;

/** The docked card: 20rem, 1rem from the area's right edge and at least 1rem clear of the column. */
const CARD_SPACE_REM = 22;

/**
 * Placement of the chat column and the thread summary (lengths in px, positions in viewport coordinates).
 * The column is centred on the window, clamped between the area's left edge (clear of the sidebar and turn rail)
 * and the docked card. When a side would collide, it moves only as far as needed, then narrows to its minimum.
 * - `docked`: the card fits beside a column of at least the minimum width, so an expanded summary stays open
 *   there; otherwise the summary is a pill that opens a popover.
 * - `floating`: the area fits a popover under the pill; narrower areas open the summary as a sheet.
 * - `offset` / `column`: where the column starts inside the area and how wide it is.
 */
export class SummaryLayout {
  /** Width of the thread area. */
  width = $state(0);
  /** Where the chat column may start (after the turn rail's padding) and how wide that space is. */
  left = $state(0);
  inner = $state(0);
  /** `--chat-width` measured in the area (the area's width for the "full" chat width). */
  chat = $state(0);
  viewport = $state(0);
  /** Briefly true after the docked card opens or closes, so the column eases to its new place. */
  settling = $state(false);

  constructor(readonly rem: () => number) {
    let previous: boolean | undefined;

    $effect(() => {
      // The first measurement places the column without easing.
      if (!this.inner) return;
      const card = this.card;

      if (previous !== undefined && previous !== card) {
        this.settling = true;
        const timer = setTimeout(() => (this.settling = false), 450);
        previous = card;

        return () => clearTimeout(timer);
      }

      previous = card;
    });
  }

  get floating(): boolean {
    return this.width >= 32 * this.rem();
  }

  get docked(): boolean {
    return this.inner > 0 && this.inner - CARD_SPACE_REM * this.rem() >= MIN_COLUMN_REM * this.rem();
  }

  /** The docked card is showing: it fits and this device keeps the summary expanded. */
  get card(): boolean {
    return this.docked && !device.view.threadPanelCollapsed;
  }

  get column(): number {
    const room = this.inner - (this.card ? CARD_SPACE_REM * this.rem() : 0);
    // The "full" chat width fills the room it gets.
    const max = this.chat >= this.inner ? room : this.chat;

    return Math.max(0, Math.min(max, room));
  }

  get offset(): number {
    const room = this.inner - (this.card ? CARD_SPACE_REM * this.rem() : 0);
    const start = this.viewport / 2 - this.column / 2 - this.left;

    return Math.round(Math.max(0, Math.min(start, room - this.column)));
  }

  /** Measures the column's space in viewport coordinates; the area resizes whenever the sidebar or Files move. */
  measure: Attachment<HTMLElement> = (node) => {
    const update = () => {
      const rect = node.getBoundingClientRect();
      this.left = rect.left;
      this.inner = rect.width;
      this.viewport = document.documentElement.clientWidth;
    };

    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener("resize", update);
    update();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  };
}
