import { screen, type Point } from "electron";
import type { ActivityNotchPlacement } from "@canopy/ui/desktop";
import { draggedPlacement, type DockedPlacement } from "./activity-notch-frame.ts";
import type { ActivityNotchRect } from "./activity-notch-geometry.ts";
import { activityNotchTab } from "./activity-notch-window.ts";

/**
 * A drag the notch page started on its header. Main reads the cursor itself, so the page only says that the
 * pointer moved and cannot place the window anywhere it likes. The notch at the camera does not move.
 */
export class ActivityNotchDrag {
  #start: { pointer: Point; tab: ActivityNotchRect } | undefined;

  get active() {
    return this.#start !== undefined;
  }

  start(placement: ActivityNotchPlacement) {
    const tab = activityNotchTab(placement);
    this.#start = tab && { pointer: screen.getCursorScreenPoint(), tab };
  }

  move(current: ActivityNotchPlacement): DockedPlacement | undefined {
    const start = this.#start;

    if (!start || current.mode === "notch") return undefined;
    const pointer = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(pointer);
    const delta = { x: pointer.x - start.pointer.x, y: pointer.y - start.pointer.y };
    const next = draggedPlacement(display.workArea, current, start.tab, delta, display.id);

    return JSON.stringify(next) === JSON.stringify(current) ? undefined : next;
  }

  /** Reports whether a drag was in progress, so only a real drop saves the place. */
  end() {
    const active = this.active;
    this.#start = undefined;

    return active;
  }
}
