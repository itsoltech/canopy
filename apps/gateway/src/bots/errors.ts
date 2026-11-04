import { InvalidError, UnavailableError } from "../core/core.ts";
import { Invalid, NotFound } from "../store/store.ts";
import { SettingsConflict, InstanceConflict, ScheduleConflict } from "../store/index.ts";
import { Code, ConnectError } from "@connectrpc/connect";

/** Only typed validation failures may reach the model; never SQL, transport diagnostics or secrets. */
export function platformError(error: unknown): { error: string } {
  if (
    error instanceof ConnectError &&
    [Code.Unavailable, Code.FailedPrecondition, Code.NotFound, Code.DeadlineExceeded].includes(error.code)
  )
    return { error: error.rawMessage };

  for (
    let cause = error, i = 0;
    cause && typeof cause === "object" && i < 8;
    i++, cause = (cause as { cause?: unknown }).cause
  ) {
    if (
      cause instanceof Invalid ||
      cause instanceof InvalidError ||
      cause instanceof UnavailableError ||
      cause instanceof NotFound ||
      cause instanceof SettingsConflict ||
      cause instanceof InstanceConflict ||
      cause instanceof ScheduleConflict
    )
      return { error: cause.message };
  }

  return { error: "Platform action rejected or unavailable" };
}
