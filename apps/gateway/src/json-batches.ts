import { Effect } from "effect";
import type { SqlError } from "effect/sql";

/** Bound bulk parameter construction; one already-validated large item may exceed the batch target. */
export function jsonBatches<A extends object, B>(
  rows: Iterable<A>,
  write: (json: string) => Effect.Effect<B, SqlError.SqlError>,
) {
  return Effect.gen(function* () {
    let batch: string[] = [];
    let bytes = 2;

    for (const row of rows) {
      const json = JSON.stringify(row);
      const size = Buffer.byteLength(json) + 1;

      if (batch.length && (bytes + size > 512 * 1024 || batch.length >= 128)) {
        yield* write(`[${batch.join(",")}]`);
        batch = [];
        bytes = 2;
      }

      batch.push(json);
      bytes += size;
    }

    if (batch.length) yield* write(`[${batch.join(",")}]`);
  });
}
