import { InvalidError, UnavailableError } from "../core/core.ts";
import { Invalid, NotFound } from "../store/store.ts";
import { SettingsConflict, InstanceConflict, ScheduleConflict } from "../store/index.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Predicate } from "effect";

/** What the model reads when a platform action fails. */
export type PlatformError = { error: string };

/** Only typed validation failures may reach the model; never SQL, transport diagnostics or secrets. */
export function platformError(cause: unknown): PlatformError {
  if (
    cause instanceof ConnectError &&
    [Code.Unavailable, Code.FailedPrecondition, Code.NotFound, Code.DeadlineExceeded].includes(cause.code)
  )
    return { error: cause.rawMessage };

  for (
    let current = cause, i = 0;
    Predicate.isObject(current) && i < 8;
    i++, current = Predicate.hasProperty(current, "cause") ? current.cause : undefined
  ) {
    if (
      current instanceof Invalid ||
      current instanceof InvalidError ||
      current instanceof UnavailableError ||
      current instanceof NotFound ||
      current instanceof SettingsConflict ||
      current instanceof InstanceConflict ||
      current instanceof ScheduleConflict
    )
      return { error: current.message };
  }

  return { error: "Platform action rejected or unavailable" };
}
