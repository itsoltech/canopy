import type { ui } from "@canopy/contracts";
import { gt, gte, valid } from "semver";

/** Unknown versions never count as proof that an installation completed. */
export function reachedUpdateVersion(current: string, target: string): boolean {
  return !!valid(current) && !!valid(target) && gte(current, target);
}

export function newerAppVersion(target: string, current: string): boolean {
  return !!valid(current) && !!valid(target) && gt(target, current);
}

/** Last request history must yield to the target's current installation or completed feed check. */
export function currentRemoteUpdate(state: ui.DesktopUpdateState): ui.DesktopUpdateState {
  if (state.phase !== "failed" || (!reachedUpdateVersion(state.version, state.targetVersion) && !state.updaterCurrent))
    return state;

  return {
    ...state,
    phase: "succeeded",
    reason: "",
    availableVersion: newerAppVersion(state.availableVersion, state.version) ? state.availableVersion : state.version,
  };
}
