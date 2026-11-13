import { Cause, Effect, Exit } from "effect";
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
      let workReasons = 0;
      let workDefects = 0;
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
              // Keep only counts: a driver failure can own the complete query payload.
              if (Exit.isFailure(exit)) {
                workReasons = exit.cause.reasons.length;

                for (const reason of exit.cause.reasons) if (Cause.isDieReason(reason)) workDefects++;
              }

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
            // Effect unions cleanup reasons, but elects defects over typed failures.
            // Counting defects separately also detects a failed cleanup replacing a work error.
            let releaseError = false;

            if (Exit.isFailure(exit)) {
              let defects = 0;

              for (const reason of exit.cause.reasons) if (Cause.isDieReason(reason)) defects++;
              releaseError = exit.cause.reasons.length > workReasons || defects > workDefects;
            }

            monitor.record(family, "release", releaseStart, releaseError, rpc);
          }

          return Effect.void;
        },
      );
    });
}
