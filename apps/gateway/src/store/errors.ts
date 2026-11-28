import { Effect } from "effect";
import type { SqlError } from "effect/sql";

export class NotFound extends Error {
  override readonly name = "NotFound";
}

export class Invalid extends Error {
  override readonly name = "Invalid";
}

/** A decision can no longer reach its waiting tool. */
export class RequestExpired extends Invalid {
  constructor() {
    super("This request expired.");
  }
}

/** A reply choice whose source is no longer the thread's current final answer. */
export class ReplySuggestionExpired extends Invalid {
  constructor() {
    super("This suggested reply is no longer available. Write a message to continue.");
  }
}

export type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid>;

export const one = <A>(rows: ReadonlyArray<A>, what: string): Effect.Effect<A, NotFound> =>
  rows[0] === undefined ? Effect.fail(new NotFound(`${what} not found`)) : Effect.succeed(rows[0]);

/** A thread frozen while it moves to another worker (docs/thread-transfers.md). */
export const TRANSFER_BUSY = "This thread is moving to another worker. Try again in a moment.";
