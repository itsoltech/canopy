/**
 * Which turn shows its quiet details (the number and time over its input, the footer's duration, model,
 * permission mode and usage): the one under the mouse, the one holding keyboard focus, and those a touch
 * reader opened with the footer's details button (`pinned`). A turn's rows are separate rows of the
 * virtual feed, each marked `data-turn` (FeedRowView), so one pair of delegated listeners follows the
 * pointer and focus across them; the details only fade (opacity), so no row changes height.
 */
class TurnReveal {
  pointer = $state("");
  focus = $state("");
  pinned = $state<ReadonlySet<string>>(new Set());
  #listening = false;

  shows(turnId: string): boolean {
    return this.pointer === turnId || this.focus === turnId || this.pinned.has(turnId);
  }

  toggle(turnId: string): void {
    const next = new Set(this.pinned);

    if (!next.delete(turnId)) next.add(turnId);
    this.pinned = next;
  }

  /** Starts following the pointer and focus (once, from the first row that needs it). */
  listen(): void {
    if (this.#listening || typeof document === "undefined") return;
    this.#listening = true;
    // Touch has no hover: a tap would reveal a turn only until the finger lifts.
    document.addEventListener("pointerover", (event) => {
      if (event.pointerType !== "touch") this.pointer = turnOf(event.target);
    });
    document.documentElement.addEventListener("pointerleave", () => (this.pointer = ""));
    document.addEventListener("focusin", (event) => (this.focus = turnOf(event.target)));
  }
}

/** The turn a node belongs to: its row's `data-turn`, or the one inside a focused feed row (article). */
function turnOf(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "";

  const row =
    target.closest<HTMLElement>("[data-turn]") ??
    (target.matches("article[data-key]") ? target.querySelector<HTMLElement>("[data-turn]") : null);

  return row?.dataset.turn ?? "";
}

export const turnReveal = new TurnReveal();
