import type { ui } from "@canopy/contracts";
import type { WorkFoldChoice } from "@canopy/domain/work-fold";
import { WorkGroupChoices } from "@canopy/domain/work-group-choices";

/** Reader state shares the snapshot ref with the watch; fold choices live as long as the retained view. */
export class MobileThreadView {
  readonly foldChoices = new Map<string, ReadonlyMap<number, WorkFoldChoice>>();
  readonly groupChoices = new WorkGroupChoices();

  constructor(public current: ui.ThreadSnapshot | undefined) {}

  get snapshot() {
    return this.current;
  }

  apply(snapshot: ui.ThreadSnapshot) {
    this.current = snapshot;
  }
}
