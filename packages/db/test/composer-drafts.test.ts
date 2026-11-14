import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "../src/testing.ts";
import { failure, id, mainThread, query, startSchemaDb, stopSchemaDb, world } from "./support/schema.ts";

describe.skipIf(!dockerAvailable)("composer draft migration", () => {
  beforeAll(startSchemaDb, 60_000);
  afterAll(stopSchemaDb);

  test("applies once, enforces payload bounds, and cascades private references on thread deletion", async () => {
    const owner = await world();
    const thread = await mainThread(owner);
    const draft = id();

    const insert = `INSERT INTO composer_drafts(id,owner_user_id,device_id,target_key,thread_id,payload,revision,mutation_id)
      VALUES($1,$2,'phone','target',$3,$4,1,'save')`;

    expect(await failure(insert, [draft, owner.user, thread, new Uint8Array(524289)])).toContain("check");
    await query(insert, [draft, owner.user, thread, new Uint8Array([1])]);
    expect(
      await query(
        "SELECT indexname FROM pg_indexes WHERE tablename='composer_drafts' AND indexname='composer_drafts_thread'",
      ),
    ).toHaveLength(1);

    const clock = await query<{ revision: bigint }>(
      "SELECT revision FROM composer_draft_clock WHERE owner_user_id=$1",
      [owner.user],
    );

    expect(BigInt(clock[0]?.revision ?? 0)).toBe(1n);
    await query("UPDATE threads SET archived_at=now() WHERE id=$1", [thread]);
    expect(await query("SELECT id FROM composer_drafts WHERE id=$1", [draft])).toHaveLength(1);
    await query("UPDATE threads SET deleted_at=now() WHERE id=$1", [thread]);
    expect(await query("SELECT id FROM composer_drafts WHERE id=$1", [draft])).toHaveLength(0);
    const next = id();
    const otherThread = await mainThread(owner);
    await query(insert, [next, owner.user, otherThread, new Uint8Array([1])]);
    await query("DELETE FROM threads WHERE id=$1", [otherThread]);
    expect(await query("SELECT id FROM composer_drafts WHERE id=$1", [next])).toHaveLength(0);
  });
});
