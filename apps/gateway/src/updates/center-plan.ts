import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { bulkUpdateSteps } from "@canopy/domain/release/update-plan";

/** Build from the authenticated snapshot only. Each action revalidates ownership and availability. */
export function updatePlan(snapshot: ui.UpdatesSnapshot): ui.UpdateRun {
  return create(ui.UpdateRunSchema, { id: crypto.randomUUID(), state: "running", steps: bulkUpdateSteps(snapshot) });
}
