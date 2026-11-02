import type { PermissionMode } from "@open-agents/contracts";
import { Schema } from "effect";

/**
 * Model, reasoning effort and permission mode of one turn (StartTurn.model / effort / permission_mode); empty
 * model or effort = the profile's default, UNSPECIFIED mode = the thread's (ThreadSpec.permission_mode).
 */
export interface TurnSettings {
  readonly model: string;
  readonly effort: string;
  readonly permissionMode?: PermissionMode;
}

/** A steer that cannot enter the turn: it is no longer running here, or the provider refused it. */
export class SteerError extends Schema.TaggedError<SteerError>()("SteerError", {
  code: Schema.Literals(["STEER_NOT_RUNNING", "STEER_REJECTED"]),
  message: Schema.String,
}) {}
