/** Past this many pixels a press on the header moves the overlay instead of toggling it. */
const dragThreshold = 4;

/**
 * Dragging the header moves an edge tab or a floating pill. The page reports one move per frame and main reads the
 * cursor itself. A notice waits while it is dragged. Expects `notch`, `toggle`, `bridge`, `collapseTimer`,
 * `noticeTimer`, `noticeId`, `scheduleNotice`, `press`, `pressFrame` and `dropped` from the page script.
 */
export const activityNotchDragScript = `
  function finishDrag(event) {
    if (!press || event.pointerId !== press.id) return;
    const moved = press.moving;
    press = undefined;
    if (!moved) return;

    cancelAnimationFrame(pressFrame);
    pressFrame = undefined;
    // The click that ends this press follows in the same task; a later click is a new one.
    dropped = true;
    setTimeout(() => (dropped = false));
    notch.removeAttribute("data-dragging");
    bridge.drag("move");
    bridge.drag("end");
    if (noticeId !== undefined) scheduleNotice();
  }

  toggle.addEventListener("pointerdown", (event) => {
    dropped = false;
    if (!notch.hasAttribute("data-draggable") || event.button !== 0) return;
    press = { id: event.pointerId, x: event.screenX, y: event.screenY, moving: false };
  });
  toggle.addEventListener("pointermove", (event) => {
    if (!press || event.pointerId !== press.id) return;
    if (!press.moving) {
      if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < ${dragThreshold}) return;
      press.moving = true;
      // Moves outside the window still reach the header, so a quick drag cannot leave the overlay behind.
      toggle.setPointerCapture(event.pointerId);
      clearTimeout(collapseTimer);
      clearTimeout(noticeTimer);
      notch.toggleAttribute("data-dragging", true);
      bridge.drag("start");
    }
    if (pressFrame) return;
    pressFrame = requestAnimationFrame(() => {
      pressFrame = undefined;
      bridge.drag("move");
    });
  });
  toggle.addEventListener("pointerup", finishDrag);
  toggle.addEventListener("pointercancel", finishDrag);
  toggle.addEventListener("lostpointercapture", finishDrag);
`;
