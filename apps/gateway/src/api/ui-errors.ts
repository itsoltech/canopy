import { Code, ConnectError } from "@connectrpc/connect";
import { Predicate } from "effect";
import { isErrorObject } from "../core/error-cause.ts";
import { ConnectorFailure } from "../connectors/store.ts";
import { InvalidError, UnavailableError } from "../core/core.ts";
import {
  InstanceConflict,
  Invalid,
  NotFound,
  QueueConflict,
  ScheduleConflict,
  SettingsConflict,
} from "../store/index.ts";

export async function guard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    throw toConnectError(error);
  }
}

/** Credential boundaries never log raw causes, including SQL bound parameters. */
export async function connectorGuard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    let current = error;

    for (let i = 0; i < 6 && isErrorObject(current); i++, current = current.cause) {
      if (current instanceof ConnectorFailure) throw new ConnectError(current.message, Code.InvalidArgument);
    }

    throw new ConnectError("Connector operation failed. Check the configuration and try again.", Code.InvalidArgument);
  }
}

/** Domain errors keep their meaning; anything else is internal and not echoed with details. */
export function toConnectError(cause: unknown): ConnectError {
  if (cause instanceof ConnectError) return cause;
  const error = unwrap(cause);

  if (error instanceof NotFound) return new ConnectError(error.message, Code.NotFound);

  if (error instanceof Invalid || error instanceof InvalidError)
    return new ConnectError(error.message, Code.InvalidArgument);

  if (error instanceof UnavailableError) return new ConnectError(error.message, Code.Unavailable);

  if (
    error instanceof SettingsConflict ||
    error instanceof InstanceConflict ||
    error instanceof QueueConflict ||
    error instanceof ScheduleConflict
  )
    return new ConnectError(error.message, Code.FailedPrecondition);
  const constraint = constraintOf(error ?? cause);

  if (constraint) return new ConnectError(`rejected by ${constraint}`, Code.FailedPrecondition);
  console.error(cause);

  return new ConnectError("internal error", Code.Internal);
}

/** Effect failures surface as FiberFailure-like wrappers; find the original error. */
export function unwrap(cause: unknown) {
  let current = cause;

  for (let i = 0; i < 5 && isErrorObject(current); i++) {
    if (
      current instanceof NotFound ||
      current instanceof Invalid ||
      current instanceof InvalidError ||
      current instanceof UnavailableError ||
      current instanceof SettingsConflict ||
      current instanceof ScheduleConflict ||
      current instanceof QueueConflict
    ) {
      return current;
    }

    current = current.cause;
  }

  return cause instanceof InstanceConflict ? cause : undefined;
}

export function constraintOf(cause: unknown): string | undefined {
  for (let current = cause, i = 0; i < 6 && isErrorObject(current); i++, current = current.cause) {
    const constraint = current.constraint;

    if (Predicate.isString(constraint)) return constraint;
  }

  return undefined;
}
