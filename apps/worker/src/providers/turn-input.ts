import { Schema } from "effect";

/** Model and reasoning effort of one turn (StartTurn.model / effort); empty = the profile's default. */
export interface TurnSettings {
  readonly model: string;
  readonly effort: string;
}

/** A steer that cannot enter the turn: it is no longer running here, or the provider refused it. */
export class SteerError extends Schema.TaggedError<SteerError>()("SteerError", {
  code: Schema.Literals(["STEER_NOT_RUNNING", "STEER_REJECTED"]),
  message: Schema.String,
}) {}
