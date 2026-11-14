/**
 * Placement of the floating thread summary in the thread area (all lengths in px).
 * - `floating`: the area fits the 20rem card; narrower areas open the summary as a sheet from its pill.
 * - `lane`: the space the card reserves on the right; the chat column centres left of it (layout.css
 *   `chat-column`). It depends on the area only, never on whether the card is open, so toggling never moves text.
 * - `overlay`: the chat column and the lane do not both fit, so the card stands over the conversation.
 */
export class SummaryLayout {
  /** Width of the thread area. */
  width = $state(0);
  /** Width of `--chat-width` measured in the area (the full width for the "full" chat width). */
  chat = $state(0);

  constructor(readonly rem: () => number) {}

  get floating(): boolean {
    return this.width >= 32 * this.rem();
  }

  get lane(): number {
    return 21.5 * this.rem();
  }

  get overlay(): boolean {
    const rem = this.rem();
    // The area's left padding keeps room for the turn rail.
    const column = this.chat >= this.width ? 36 * rem : this.chat;

    return this.width - 2.25 * rem < column + this.lane;
  }
}
