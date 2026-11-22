import { fromJson } from "@bufbuild/protobuf";
import { SandboxProfileBindingSchema, type ThreadSpec } from "@canopy/contracts";
import type { ThreadRow } from "./rows.ts";

export const DRAFT_SANDBOX_RESELECT =
  "This draft’s sandbox profile is missing or has changed. Reselect the profile, then send it again.";

export const SANDBOX_DERIVATION_UNAVAILABLE = "This action is unavailable for threads with a sandbox profile.";

export function threadSandbox(row: Pick<ThreadRow, "settings">) {
  const binding = row.settings.sandboxProfile;

  return binding == null ? undefined : fromJson(SandboxProfileBindingSchema, binding);
}

/** The legacy worker sees a missing thread spec and cannot run a bound command. */
export function sandboxCommandThread(spec: ThreadSpec) {
  const { sandboxProfile: binding, ...thread } = spec;

  return binding ? { profiledThread: { thread, binding } } : { thread: spec };
}
