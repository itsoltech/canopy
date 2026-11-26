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
 * Docking uses the target width of the thread area, so it is decided at the start of the panel motion.
 */
export class SummaryLayout {
  /** Live border box of the thread area for sizing the floating popover. */
  areaSize = $state.raw<readonly ResizeObserverSize[]>([]);
  /** The rail's reserved space at the leading edge, set by the responsive CSS. */
  railSize = $state.raw<readonly ResizeObserverSize[]>([]);
  /** Width of the collapsed summary beside the timeline. */
  pillWidth = $state(0);
  /** Briefly true after the docked card opens or closes, so the column eases to its new place. */
  settling = $state(false);

  constructor(readonly space: { readonly rem: number; readonly threadAreaWidth: number }) {
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
    return Math.round(this.areaSize[0]?.inlineSize ?? 0) >= 32 * this.space.rem;
  }

  get inner(): number {
    const rail = this.railSize[0];

    return rail ? Math.max(0, this.space.threadAreaWidth - rail.inlineSize) : 0;
  }

  get docked(): boolean {
    return this.inner > 0 && this.inner - CARD_SPACE_REM * this.space.rem >= MIN_COLUMN_REM * this.space.rem;
  }

  /** The docked card is showing: it fits and this device keeps the summary expanded. */
  get card(): boolean {
    return this.docked && !device.view.threadPanelCollapsed;
  }
}
