/** Fixed-height output rows: only the viewport and its overscan enter the DOM. */
export const OUTPUT_LINE_HEIGHT = 20;

export function outputRange(count: number, top: number, height: number): [number, number] {
  const start = Math.max(0, Math.floor(Math.max(0, top) / OUTPUT_LINE_HEIGHT) - 8);

  return [Math.min(count, start), Math.min(count, Math.ceil((Math.max(0, top) + height) / OUTPUT_LINE_HEIGHT) + 8)];
}

/** Compare positions, not growing scrollHeight: arriving output cannot release the pin. */
export class OutputPin {
  pinned = true;
  top = 0;

  scroll(top: number, height: number, total: number): void {
    if (top < this.top - 1) this.pinned = false;
    else if (total - top - height <= 4) this.pinned = true;
    this.top = top;
  }

  latest(height: number, total: number): number {
    this.pinned = true;

    return (this.top = Math.max(0, total - height));
  }
}
