import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "../src/testing.ts";
import {
  failure,
  id,
  insertSide,
  mainThread,
  query,
  startSchemaDb,
  stopSchemaDb,
  world,
  type World,
} from "./support/schema.ts";

/**
 * Migration 0227 (docs/thread-transfers.md): a frozen thread admits no new work, and its placement changes only in
 * the transaction that commits its own prepared transfer, to exactly the target that transfer prepared.
 */
describe.skipIf(!dockerAvailable)("thread transfers on PostgreSQL 17", () => {
  beforeAll(() => startSchemaDb(), 60_000);
  afterAll(stopSchemaDb);

  async function prepared(w: World, thread: string) {
    const transfer = id();
    const workspace = id();
    await query(`INSERT INTO project_workspaces (id, project_id, worker_id, root_path) VALUES ($1, $2, $3, '/b')`, [
      workspace,
      w.project,
      w.otherWorker,
    ]);
    await query(
      `INSERT INTO thread_transfers(owner_user_id,id,thread_id,family,source_worker_id,target_worker_id,
        source_workspace_id,target_workspace_id,source_cwd,target_cwd,state)
      VALUES ($1,$2,$3,ARRAY[$3]::uuid[],$4,$5,$6,$7,'/repo','/b','prepared')`,
      [w.user, transfer, thread, w.worker, w.otherWorker, w.workspace, workspace],
    );
    await query(`UPDATE threads SET transfer_pending_id = $2 WHERE id = $1`, [thread, transfer]);

    return { transfer, workspace };
  }

  /** The update as the commit runs it: the transaction names the transfer first (`transfer` empty: it does not). */
  const MOVE = `WITH named AS (SELECT set_config('canopy.thread_transfer', $5, true))
    UPDATE threads SET worker_id=$2, workspace_id=$3, cwd=$4, transfer_pending_id=NULL FROM named WHERE id=$1`;

  test("a frozen thread refuses turns, restored turns, side threads, schedule changes and archiving", async () => {
    const w = await world();
    const thread = await mainThread(w);
    const withdrawn = id();
    const schedule = id();
    await query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input)
      VALUES($1,$2,1,'cancelled','user',$3,'{}')`,
      [withdrawn, thread, w.user],
    );
    await query(
      `INSERT INTO schedules(id,thread_id,project_id,created_by_user_id,kind,prompt,cron,status)
      VALUES($1,$2,$3,$4,'recurring','x','0 * * * *','paused')`,
      [schedule, thread, w.project, w.user],
    );
    await prepared(w, thread);
    const side = insertSide(w, { parent: thread, root: thread });

    expect(await failure(`UPDATE turns SET status = 'queued' WHERE id = $1`, [withdrawn])).toContain(
      "This thread is moving",
    );
    expect(await failure(side.sql, side.params)).toContain("moving to another worker");
    expect(await failure(`UPDATE schedules SET status = 'active' WHERE id = $1`, [schedule])).toContain(
      "moving to another worker",
    );

    expect(
      await failure(
        `INSERT INTO turns(id,thread_id,ordinal,status,trigger,input) VALUES($1,$2,1,'queued','user','{}')`,
        [id(), thread],
      ),
    ).toContain("This thread is moving to another worker");
    expect(await failure(`UPDATE threads SET archived_at = now() WHERE id = $1`, [thread])).toContain(
      "moving to another worker",
    );
  });

  test("placement moves only with the committing transfer, to its prepared target", async () => {
    const w = await world();
    const thread = await mainThread(w);
    const { transfer, workspace } = await prepared(w, thread);

    expect(await failure(MOVE, [thread, w.otherWorker, workspace, "/b", ""])).toContain("immutable");
    expect(await failure(MOVE, [thread, w.otherWorker, workspace, "/elsewhere", transfer])).toContain("immutable");
    await query(MOVE, [thread, w.otherWorker, workspace, "/b", transfer]);
    expect(await query(`SELECT worker_id, cwd, transfer_pending_id FROM threads WHERE id = $1`, [thread])).toEqual([
      { worker_id: w.otherWorker, cwd: "/b", transfer_pending_id: null },
    ]);
  });
});
