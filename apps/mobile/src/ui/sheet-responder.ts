interface SheetTouch {
  numberActiveTouches: number;
  dx: number;
  dy: number;
}

type SheetTouchTarget = "drag-area" | "header-control" | "content";

/** Start negotiation bubbles: a child control gets first refusal before the drag area. */
export function shouldStartSheetResponder(gesture: SheetTouch, target: SheetTouchTarget) {
  return target === "drag-area" && gesture.numberActiveTouches === 1;
}

/** Capture may take a vertical drag from a header control, but never from sheet content. */
export function shouldMoveSheetResponder(gesture: SheetTouch, target: SheetTouchTarget, threshold = 6) {
  return (
    target !== "content" &&
    gesture.numberActiveTouches === 1 &&
    Math.abs(gesture.dy) > threshold &&
    Math.abs(gesture.dy) > Math.abs(gesture.dx)
  );
}
