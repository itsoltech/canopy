import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "../src/testing.ts";
import {
  completedTurn,
  id,
  mainThread,
  query,
  sideThread,
  startSchemaDb,
  stopSchemaDb,
  world,
} from "./support/schema.ts";

async function seed(thread: string) {
  await query(`INSERT INTO thread_replication_sources(thread_id) VALUES($1)`, [thread]);
  await query(
    `INSERT INTO thread_replication_clock(thread_id,owner_user_id) SELECT id,owner_user_id FROM threads WHERE id=$1`,
    [thread],
  );
  await query(`SELECT thread_replication_seed($1)`, [thread]);
}

async function revision(thread: string) {
  const [row] = await query<{ revision: string }>(
    `SELECT c.revision::text FROM computer_thread_clock c JOIN threads t ON t.owner_user_id=c.owner_user_id WHERE t.id=$1`,
    [thread],
  );

  return row!.revision;
}

function changes(thread: string, after: string) {
  return query<{ entity_kind: string; entity_id: string }>(
    `SELECT entity_kind,entity_id FROM computer_thread_changes WHERE thread_id=$1 AND revision>$2 ORDER BY revision`,
    [thread, after],
  );
}

function event(thread: string, seq: number, kind: string) {
  return query(
    `INSERT INTO thread_events(thread_id,seq,event_id,origin,kind,item_id,payload,occurred_at)
     VALUES($1,$2,$3,'worker',$4,CASE WHEN left($4,5)='item_' THEN 'message' END,'{}',now())`,
    [thread, seq, id(), kind],
  );
}

function keys(thread: string) {
  return query<{ kind: string; entity_id: string }>(
    `SELECT kind,entity_id FROM thread_replication_journal WHERE thread_id=$1 ORDER BY kind,entity_id`,
    [thread],
  );
}

describe.skipIf(!dockerAvailable)("notice replication source triggers", () => {
  beforeAll(async () => {
    await startSchemaDb();
  }, 60_000);
  afterAll(stopSchemaDb);

  test("non-notice inserts, updates and deletes do not change either journal", async () => {
    const thread = await mainThread(await world());
    await seed(thread);
    const before = await revision(thread);
    const clock = await query(`SELECT * FROM thread_replication_clock WHERE thread_id=$1`, [thread]);
    const kinds = ["item_started", "item_delta", "item_completed", "turn_started", "turn_finished", "activity"];

    for (const [index, kind] of kinds.entries()) await event(thread, index + 1, kind);
    await query(`UPDATE thread_events SET raw='{"updated":true}' WHERE thread_id=$1`, [thread]);
    await query(`DELETE FROM thread_events WHERE thread_id=$1`, [thread]);

    expect(await changes(thread, before)).toEqual([]);
    expect(await query(`SELECT * FROM thread_replication_clock WHERE thread_id=$1`, [thread])).toEqual(clock);
    expect(await keys(thread)).toEqual([{ kind: "thread", entity_id: thread }]);
  });

  test("notice insert, update, kind transitions and delete invalidate the original seq", async () => {
    const thread = await mainThread(await world());
    await seed(thread);

    const check = async (write: () => Promise<object>) => {
      const before = await revision(thread);
      await write();
      expect(await changes(thread, before)).toEqual([{ entity_kind: "thread_events", entity_id: "1" }]);
      expect(await keys(thread)).toEqual([
        { kind: "notice", entity_id: "1" },
        { kind: "thread", entity_id: thread },
      ]);
    };

    await check(() => event(thread, 1, "notice"));
    await check(() =>
      query(`UPDATE thread_events SET payload='{"notice":{"message":"updated"}}' WHERE thread_id=$1`, [thread]),
    );
    await check(() => query(`UPDATE thread_events SET kind='activity' WHERE thread_id=$1`, [thread]));
    await check(() => query(`UPDATE thread_events SET kind='notice' WHERE thread_id=$1`, [thread]));
    await check(() => query(`DELETE FROM thread_events WHERE thread_id=$1`, [thread]));
  });

  test("forks retain item, turn and header invalidations without raw event fan-out", async () => {
    const w = await world();
    const thread = await mainThread(w);
    const turn = await completedTurn(w, thread, ["inherited"]);
    const fork = await sideThread(w, { parent: thread, root: thread, forkSource: thread });
    await seed(thread);
    await seed(fork);
    const before = await revision(thread);
    await event(thread, 2, "item_delta");
    expect(await changes(thread, before)).toEqual([]);
    expect(await changes(fork, before)).toEqual([]);
    await query(`UPDATE thread_items SET last_seq=2 WHERE thread_id=$1`, [thread]);
    await query(`UPDATE turns SET model='updated' WHERE id=$1`, [turn]);
    await query(`UPDATE threads SET last_seq=2 WHERE id=$1`, [thread]);

    for (const target of [thread, fork])
      expect(await keys(target)).toEqual([
        { kind: "item", entity_id: "item-inherited" },
        { kind: "thread", entity_id: target },
        { kind: "turn", entity_id: turn },
      ]);
    expect((await changes(thread, before)).map((row) => row.entity_kind)).toEqual(["thread_items", "turns", "threads"]);
  });

  test("deletion still invalidates the header and purging notices stays silent", async () => {
    const thread = await mainThread(await world());
    await event(thread, 1, "notice");
    await event(thread, 2, "item_delta");
    await seed(thread);
    const before = await revision(thread);
    await query(`UPDATE threads SET deleted_at=now(),purged_at=now() WHERE id=$1`, [thread]);
    expect((await changes(thread, before)).map((row) => row.entity_kind)).toEqual(["threads"]);
    const deleted = await revision(thread);
    await query(`DELETE FROM thread_events WHERE thread_id=$1`, [thread]);
    expect(await changes(thread, deleted)).toEqual([]);
    await event(thread, 3, "notice");
    expect(await changes(thread, deleted)).toEqual([]);
    expect(await query(`SELECT seq FROM thread_events WHERE thread_id=$1`, [thread])).toEqual([]);
  });

  test("a worker heartbeat queues no thread change; other worker changes still fan out", async () => {
    const w = await world();
    const thread = await mainThread(w);
    await seed(thread);

    const workerChanges = (after: string) =>
      query<{ entity_kind: string }>(
        `SELECT entity_kind FROM computer_thread_changes WHERE owner_user_id=$1 AND revision>$2 AND entity_id=$3`,
        [w.user, after, w.worker],
      );

    const head = async () =>
      (
        await query<{ version: string }>(
          `SELECT change_version::text AS version FROM thread_replication_clock WHERE thread_id=$1`,
          [thread],
        )
      )[0]!.version;

    const before = await revision(thread);
    const version = await head();
    await query(`UPDATE workers SET last_seen_at=now() WHERE id=$1`, [w.worker]);
    expect(await workerChanges(before)).toEqual([]);
    expect(await head()).toBe(version);

    await query(`UPDATE workers SET last_seen_at=now(), name='renamed' WHERE id=$1`, [w.worker]);
    expect(await workerChanges(before)).toEqual([{ entity_kind: "workers" }]);
    expect(await head()).not.toBe(version);
  });
});
