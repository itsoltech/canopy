/**
 * Placement of the thread summary in the thread area (all lengths in px). The chat column is always centred in
 * the area with its own max width; the summary only uses space the column leaves free, so it never moves text.
 * - `docked`: the right gutter beside the centred column holds the 20rem card plus its inset and a gap, so an
 *   expanded summary can stay open there.
 * - `floating`: the area fits a popover under the pill; narrower areas open the summary as a sheet.
 */
export class SummaryLayout {
  /** Width of the thread area. */
  width = $state(0);
  /** Width the chat column centres in: the area without the turn rail's padding. */
  inner = $state(0);
  /** `--chat-width` measured in the area (the full width for the "full" chat width). */
  chat = $state(0);

  constructor(readonly rem: () => number) {}

  get floating(): boolean {
    return this.width >= 32 * this.rem();
  }

  get docked(): boolean {
    const column = Math.min(this.chat, this.inner);

    // 20rem card, 1rem inset from the area's edge and at least 1rem clear of the column.
    return this.inner > 0 && (this.inner - column) / 2 >= 22 * this.rem();
  }
}
