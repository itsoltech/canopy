import { Effect, Equal, Exit } from "effect";
import type { SqlConnection, SqlError } from "effect/sql";
import type { DatabaseMonitor } from "./database.ts";
import { QueryFamily, QueryRpc } from "./query-context.ts";

/** Observe the native borrow without adding a scope or changing its release semantics. */
export function observedBorrow(borrow: SqlConnection.Borrower, monitor: DatabaseMonitor): SqlConnection.Borrower {
  return <A, E, R>(
    work: (connection: SqlConnection.Connection) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError.SqlError, R> =>
    Effect.withFiber((fiber) => {
      if (!monitor.enabled) return borrow(work);
      const family = fiber.getRef(QueryFamily);
      const rpc = fiber.getRef(QueryRpc);
      const start = performance.now();
      let acquired = false;
      let releaseStart = start;
      let workFailure: Exit.Failure<A, E> | undefined;
      monitor.waiting++;
      monitor.peakWaiting = Math.max(monitor.peakWaiting, monitor.waiting);

      return Effect.onExit(
        borrow((connection) => {
          acquired = true;
          monitor.waiting--;
          monitor.occupied++;
          monitor.peakOccupied = Math.max(monitor.peakOccupied, monitor.occupied);
          monitor.record(family, "reserve", start, false, rpc);

          return Effect.onExit(
            Effect.suspend(() => work(connection)),
            (exit) => {
              // Successful row sets must never become captured diagnostic closure state.
              if (Exit.isFailure(exit)) workFailure = exit;
              releaseStart = performance.now();

              return Effect.void;
            },
          );
        }),
        (exit) => {
          if (!acquired) {
            monitor.waiting--;
            monitor.record(family, "reserve", start, Exit.isFailure(exit), rpc);
          } else {
            monitor.occupied--;
            // A work failure alone is not a release error; an added cleanup cause is.
            const releaseError = Exit.isFailure(exit) && !Equal.equals(exit, workFailure);
            workFailure = undefined;
            monitor.record(family, "release", releaseStart, releaseError, rpc);
          }

          return Effect.void;
        },
      );
    });
}
