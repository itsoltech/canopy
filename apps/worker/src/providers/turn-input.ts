import type { PermissionMode } from "@canopy/contracts";
import { Schema } from "effect";

/**
 * Model, reasoning effort and permission mode of one turn (StartTurn.model / effort / permission_mode); empty
 * model or effort = the profile's default, UNSPECIFIED mode = the thread's (ThreadSpec.permission_mode).
 */
export interface TurnSettings {
  readonly model: string;
  readonly effort: string;
  readonly permissionMode?: PermissionMode;
  /** Previous request, used privately only when a retry has to create a fresh provider session. */
  readonly recoveryContext?: string;
  /** Called only after this turn's connector catalog has attached successfully. */
  readonly connectorsReady?: () => Promise<void>;
  readonly connectorNote?: string;
  /** Synchronous fence checked after async preparation, immediately before provider submission. */
  readonly canSubmit?: () => boolean;
}

export class TurnAdmissionCancelled extends Error {
  constructor() {
    super("The turn was cancelled before submission.");
  }
}

/** A steer that cannot enter the turn: it is no longer running here, or the provider refused it. */
export class SteerError extends Schema.TaggedError<SteerError>()("SteerError", {
  code: Schema.Literals(["STEER_NOT_RUNNING", "STEER_REJECTED"]),
  message: Schema.String,
}) {}
