import type { Attachment } from "svelte/attachments";
import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";

/** The chat column never gets narrower than this to make room for the docked summary. */
const MIN_COLUMN_REM = 36;

/** The docked card: 20rem, 1rem from the area's right edge and at least 1rem clear of the column (layout.css). */
const CARD_SPACE_REM = 22;

/**
 * Placement of the thread summary beside the chat column (lengths in px). The column itself is placed in CSS
 * (layout.css `data-chat-placement`): centred on the window, clamped between the area's start and the docked card.
 * - `docked`: the card fits beside a column of at least the minimum width, so an expanded summary stays open
 *   there; otherwise the summary is a pill that opens a popover.
 * - `floating`: the area fits a popover under the pill; narrower areas open the summary as a sheet.
 * The decision uses the area's width where the sidebar and Files are going (`travel`), so it is made once when
 * one of them starts to ease and never flips while it moves.
 */
export class SummaryLayout {
  /** Width of the thread area. */
  width = $state(0);
  /** Width of the collapsed summary beside the timeline. */
  pillWidth = $state(0);
  /** Width the chat column may use (the area without the turn rail's padding) once the sidebar and Files settle. */
  inner = $state(0);
  /** Briefly true after the docked card opens or closes, so the column eases to its new place. */
  settling = $state(false);

  /**
   * @param space the thread's workspace: its rem and how much wider the area will be once the sidebar and Files
   *   have eased (`travel`, negative when it narrows), read in the measuring callback.
   */
  constructor(readonly space: { readonly rem: number; travel(areaRight: number): number }) {
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
    return this.width >= 32 * this.space.rem;
  }

  get docked(): boolean {
    return this.inner > 0 && this.inner - CARD_SPACE_REM * this.space.rem >= MIN_COLUMN_REM * this.space.rem;
  }

  /** The docked card is showing: it fits and this device keeps the summary expanded. */
  get card(): boolean {
    return this.docked && !device.view.threadPanelCollapsed;
  }

  /** Measures the column's space; it resizes whenever the sidebar, Files or the window move. */
  measure: Attachment<HTMLElement> = (node) => {
    const update = () => {
      const rect = node.getBoundingClientRect();
      this.inner = Math.max(0, rect.width + this.space.travel(rect.right));
    };

    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();

    return () => observer.disconnect();
  };
}
