import { PgClient } from "@effect/sql-pg";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { gatewayServices } from "../../apps/gateway/src/runtime.ts";
import { tracedSql, type Recorder } from "./trace.ts";

export function runtime(url: string, recorder?: Recorder) {
  const database = PgClient.layer({
    url: Redacted.make(url),
    applicationName: "canopy-db-bench",
    maxConnections: 8,
  });

  const sql = recorder ? tracedSql(recorder).pipe(Layer.provideMerge(database)) : database;

  return ManagedRuntime.make(gatewayServices(Buffer.alloc(32, 1)).pipe(Layer.provideMerge(sql)));
}

export type BenchRuntime = ReturnType<typeof runtime>;
