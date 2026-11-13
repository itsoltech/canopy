import { Effect, Exit, Stream } from "effect";
import type { SqlConnection } from "effect/sql";
import type { DatabaseFamily, DatabasePhase } from "@canopy/domain/diagnostics";
import type { DatabaseMonitor } from "./database.ts";
import { QueryFamily, QueryRpc } from "./query-context.ts";

type SqlParameters = Parameters<SqlConnection.Connection["execute"]>[1];

type Transform = Parameters<SqlConnection.Connection["execute"]>[2];

/** Separate lexical scope: completion hooks cannot capture SQL work, parameters or connections. */
function completion(
  monitor: DatabaseMonitor,
  family: DatabaseFamily,
  phase: DatabasePhase,
  rpc: number,
  start: number,
) {
  return <A, E>(exit: Exit.Exit<A, E>) => {
    monitor.record(family, phase, start, Exit.isFailure(exit), rpc);

    return Effect.void;
  };
}

/** Read references directly from the consuming fiber; avoid generators and context copies. */
export function observed<A, E, R>(monitor: DatabaseMonitor, phase: DatabasePhase, work: Effect.Effect<A, E, R>) {
  return Effect.withFiber((fiber) => {
    if (!monitor.enabled) return work;
    const family = fiber.getRef(QueryFamily);
    const rpc = fiber.getRef(QueryRpc);
    const start = performance.now();

    return Effect.onExit(work, completion(monitor, family, phase, rpc, start));
  });
}

/** Prototype methods replace six new closures on every checkout. No SQL enters the monitor. */
export class ObservedConnection implements SqlConnection.Connection {
  constructor(
    readonly connection: SqlConnection.Connection,
    readonly monitor: DatabaseMonitor,
  ) {}

  execute(text: string, params: SqlParameters, transform: Transform) {
    return observed(this.monitor, "execute", this.connection.execute(text, params, transform));
  }

  executeUnprepared(text: string, params: SqlParameters, transform: Transform) {
    return observed(this.monitor, "execute", this.connection.executeUnprepared(text, params, transform));
  }

  executeRaw(text: string, params: SqlParameters) {
    return observed(this.monitor, "execute", this.connection.executeRaw(text, params));
  }

  executeValues(text: string, params: SqlParameters) {
    return observed(this.monitor, "execute", this.connection.executeValues(text, params));
  }

  executeValuesUnprepared(text: string, params: SqlParameters) {
    return observed(this.monitor, "execute", this.connection.executeValuesUnprepared(text, params));
  }

  executeStream(text: string, params: SqlParameters, transform: Transform) {
    return Stream.unwrap(
      Effect.withFiber((fiber) => {
        const work = this.connection.executeStream(text, params, transform);

        if (!this.monitor.enabled) return Effect.succeed(work);
        const family = fiber.getRef(QueryFamily);
        const rpc = fiber.getRef(QueryRpc);
        const start = performance.now();

        return Effect.succeed(Stream.onExit(work, completion(this.monitor, family, "execute", rpc, start)));
      }),
    );
  }
}
