import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";

/** Hints are bounded, owner-checked by ThreadFiles, and confined to the source item's own turn. */
export async function referencePaths(core: GatewayCore, threadId: string, itemId: string, name: string) {
  if (!itemId || /[\\/]/.test(name)) return [];

  const rows = await core[coreState].actions.run(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ text: string }>`
      SELECT left(i.content::text, 65536) AS text FROM thread_items i
      JOIN thread_items source ON source.thread_id=i.thread_id AND source.turn_id=i.turn_id
      WHERE source.thread_id=${threadId}::uuid AND source.item_id=${itemId}
      ORDER BY i.first_seq DESC LIMIT 64
    `),
  );

  const paths = new Set<string>();

  for (const row of rows) {
    // Includes paths in shell commands and JSON tool arguments, without executing or trusting either.
    const tokens = row.text.match(/[^\s"'`<>(){}[\],;=|]+[\\/][^\s"'`<>(){}[\],;=|]+/g) ?? [];

    for (const token of tokens) {
      const path = token.replace(/\\\\/g, "\\").replace(/:\d+(?::\d+)?$/, "");

      if (path.split(/[\\/]/).at(-1) === name && path.length <= 4096) paths.add(path);

      if (paths.size >= 32) return [...paths];
    }
  }

  return [...paths];
}
