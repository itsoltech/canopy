/** Downward travel stays 1:1; upward travel approaches a bounded, diminishing resistance. */
export function sheetDragOffset(distance: number, height: number) {
  "worklet";

  if (distance >= 0) return distance;
  const limit = Math.max(1, height) * 0.15;

  return (distance * limit) / (limit - distance);
}

/** Recover finger travel when grabbing a sheet during its rubber-band return. */
export function sheetDragDistance(offset: number, height: number) {
  "worklet";

  if (offset >= 0) return offset;
  const limit = Math.max(1, height) * 0.15;

  return (offset * limit) / Math.max(0.001, limit + offset);
}

/** Velocity is dp/second (PanResponder reports dp/millisecond). An upward reversal cancels dismissal. */
export function shouldDismissSheet(offset: number, height: number, velocity: number) {
  "worklet";

  return height > 0 && offset > 0 && velocity > -300 && (offset / height >= 0.28 || (offset >= 8 && velocity >= 900));
}
