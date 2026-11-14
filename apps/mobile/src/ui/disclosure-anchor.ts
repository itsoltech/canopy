/** Distance from the inverted content's start, independent of Fabric's scroll-offset checkpoint. */
export function disclosurePosition(cellY: number, cellHeight: number, cellTop: number, headerTop: number) {
  "worklet";

  return cellY + cellHeight - (headerTop - cellTop);
}

/** An absolute target: repeating a layout measurement must never compound a correction. */
export function disclosureOffset(offset: number, position: number, nextPosition: number, minimum: number) {
  "worklet";

  return Math.max(minimum, offset + nextPosition - position);
}
