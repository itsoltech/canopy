import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "../src/testing.ts";
import {
  completedTurn,
  mainThread,
  query,
  runMigrations,
  startSchemaDb,
  stopSchemaDb,
  world,
} from "./support/schema.ts";

describe.skipIf(!dockerAvailable)("history read indexes", () => {
  beforeAll(startSchemaDb, 60_000);
  afterAll(stopSchemaDb);

  test("all new indexes are valid and migrations stay idempotent", async () => {
    const rows = await query<{ name: string; valid: boolean }>(`SELECT c.relname AS name,i.indisvalid AS valid
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname IN ('turns_unseen','thread_items_turn_order',
        'thread_items_last_answer','thread_events_notices') ORDER BY c.relname`);

    expect(rows).toEqual([
      { name: "thread_events_notices", valid: true },
      { name: "thread_items_last_answer", valid: true },
      { name: "thread_items_turn_order", valid: true },
      { name: "turns_unseen", valid: true },
    ]);
    expect(await runMigrations()).toEqual([]);
  });

  test("unseen lookups retain completed history", async () => {
    const w = await world();
    const thread = await mainThread(w);
    const completed = await completedTurn(w, thread, ["A retained answer"]);

    const rows = await query<{ last_seq: string }>(
      `SELECT
      (SELECT last_seq::text FROM turns WHERE thread_id=$1 AND status IN ('completed','failed','interrupted')
        ORDER BY last_seq DESC LIMIT 1) AS last_seq`,
      [thread],
    );

    expect(await query(`SELECT id FROM turns WHERE id=$1`, [completed])).toHaveLength(1);
    expect(BigInt(rows[0]!.last_seq)).toBeGreaterThan(0n);
    expect((await query(`SELECT content FROM thread_items WHERE thread_id=$1`, [thread])).length).toBeGreaterThan(0);
  });
});
