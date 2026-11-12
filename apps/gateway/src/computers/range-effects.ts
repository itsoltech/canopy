import { Cause, Exit } from "effect";

/** Keep typed range/cursor errors at the asynchronous transport boundary. */
export function rangeResult<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);

  return exit.value;
}
