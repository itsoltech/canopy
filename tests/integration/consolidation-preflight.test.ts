import { expect, test } from "bun:test";
import { dockerAvailable, startPostgres } from "@canopy/db/testing";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { consolidationPreflight } from "../../apps/gateway/src/migration/consolidation-inventory.ts";

function seed(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const owner = Bun.randomUUIDv7();
    const other = Bun.randomUUIDv7();
    const worker = Bun.randomUUIDv7();
    const foreignWorker = Bun.randomUUIDv7();
    const sharedWorker = Bun.randomUUIDv7();
    const project = Bun.randomUUIDv7();
    const foreignProject = Bun.randomUUIDv7();
    const workspace = Bun.randomUUIDv7();
    const foreignWorkspace = Bun.randomUUIDv7();
    const thread = Bun.randomUUIDv7();
    const foreignThread = Bun.randomUUIDv7();
    const side = Bun.randomUUIDv7();
    const moved = Bun.randomUUIDv7();
    const deleted = Bun.randomUUIDv7();
    const bot = Bun.randomUUIDv7();
    const foreignBot = Bun.randomUUIDv7();
    const turn = Bun.randomUUIDv7();
    const attachment = Bun.randomUUIDv7();
    const schedule = Bun.randomUUIDv7();
    const newThreadSchedule = Bun.randomUUIDv7();
    const move = Bun.randomUUIDv7();
    const node = "a".repeat(64);
    const peer = "b".repeat(64);
    const relay = "c".repeat(64);
    const foreignPeer = "d".repeat(64);
    const remoteParentRef = `${Bun.randomUUIDv7()}~${peer.slice(0, 16)}`;
    const privateBytes = Buffer.from("private fixture");
    yield* sql`INSERT INTO users(id,email,display_name,role) VALUES
      (${owner}::uuid,'source@example.test','Owner','user'),(${other}::uuid,'other@example.test','Other','user')`;
    yield* sql`INSERT INTO computer_identity(owner_user_id,node_id,name,certificate,private_key)
      VALUES(${owner}::uuid,${node},'Source','certificate fixture',${privateBytes})`;
    yield* sql`INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint,status) VALUES
      (${owner}::uuid,${peer},'Peer','peer certificate fixture','peer fingerprint fixture','unreachable'),
      (${other}::uuid,${foreignPeer},'Foreign peer','foreign cert','foreign fingerprint','connected')`;
    yield* sql`INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint,via_node_id,relay_role)
      VALUES(${owner}::uuid,${relay},'Relayed','','',${peer},'both')`;
    yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash,revoked_at) VALUES
      (${worker}::uuid,${owner}::uuid,'Execution worker','worker credential fixture',now()),
      (${sharedWorker}::uuid,NULL,'Shared worker','shared credential fixture',NULL),
      (${Bun.randomUUIDv7()}::uuid,NULL,'Unrelated worker','unrelated credential fixture',NULL),
      (${foreignWorker}::uuid,${other}::uuid,'Foreign worker','foreign credential fixture',NULL)`;
    yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES
      (${project}::uuid,${owner}::uuid,'Source project','source-project'),
      (${foreignProject}::uuid,${other}::uuid,'Foreign project','foreign-project')`;
    yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES
      (${workspace}::uuid,${project}::uuid,${worker}::uuid,'/private-fixture-root'),
      (${foreignWorkspace}::uuid,${foreignProject}::uuid,${foreignWorker}::uuid,'/foreign'),
      (${Bun.randomUUIDv7()}::uuid,${project}::uuid,${sharedWorker}::uuid,'/shared')`;

    for (const id of [thread, moved, deleted])
      yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd,status,provider_thread_id)
        VALUES(${id}::uuid,${project}::uuid,${owner}::uuid,'main',${id}::uuid,'worker','codex',${worker}::uuid,
          ${workspace}::uuid,'/private-fixture-root','idle',${`private-session-${id}`})`;

    yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd)
      VALUES(${foreignThread}::uuid,${foreignProject}::uuid,${other}::uuid,'main',${foreignThread}::uuid,
        'worker','codex',${foreignWorker}::uuid,${foreignWorkspace}::uuid,'/foreign')`;
    yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,parent_thread_id,depth,runtime,provider,
        worker_id,workspace_id,cwd,status,remote_parent_ref,remote_parent_kind)
      VALUES(${side}::uuid,${project}::uuid,${owner}::uuid,'side',${thread}::uuid,${thread}::uuid,1,
        'worker','codex',${worker}::uuid,${workspace}::uuid,'/private-fixture-root','idle',${remoteParentRef},'thread')`;
    yield* sql`UPDATE threads SET deleted_at=now(),moved_to=${peer} WHERE id=${moved}::uuid`;
    yield* sql`UPDATE threads SET deleted_at=now() WHERE id=${deleted}::uuid`;
    yield* sql`INSERT INTO computer_redirects(owner_user_id,kind,item_id,from_node_id,home_node_id,basis,moved_at)
      VALUES(${owner}::uuid,'thread',${moved}::uuid,${node},${peer},'local_move',now())`;
    yield* sql`INSERT INTO computer_moves(owner_user_id,id,role,peer_node_id,kind,item_id,state,payload)
      VALUES(${owner}::uuid,${move}::uuid,'target',${peer},'thread',${Bun.randomUUIDv7()}::uuid,'prepared',${privateBytes})`;

    yield* sql`INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES
      (${owner}::uuid,${peer}),(${other}::uuid,${foreignPeer})`;
    yield* sql`INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
      SELECT owner_user_id,origin_node_id,generation,${moved}::uuid,${privateBytes},${privateBytes} FROM computer_mirror_state
      UNION ALL SELECT owner_user_id,origin_node_id,gen_random_uuid(),${thread}::uuid,${privateBytes},${privateBytes}
        FROM computer_mirror_state`;
    yield* sql`INSERT INTO computer_mirror_bots(owner_user_id,origin_node_id,bot_id,snapshot)
      VALUES(${owner}::uuid,${peer},${bot}::uuid,${privateBytes})`;
    yield* sql`INSERT INTO config_items(owner_user_id,kind,global_id,home_node_id,revision)
      VALUES(${owner}::uuid,'worker',${Bun.randomUUIDv7()},${peer},1)`;

    yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input)
      VALUES(${turn}::uuid,${thread}::uuid,1,'queued','user',${owner}::uuid,'{}')`;
    const sha = Bun.SHA256.hash(privateBytes, "hex");
    yield* sql`INSERT INTO blobs(sha256,size_bytes,data) VALUES(${sha},${privateBytes.length},${privateBytes})`;
    yield* sql`INSERT INTO attachments(id,owner_user_id,thread_id,turn_id,sha256,name,mime_type,kind,size_bytes) VALUES
      (${attachment}::uuid,${owner}::uuid,${thread}::uuid,${turn}::uuid,${sha},'private.txt','text/plain','file',${privateBytes.length}),
      (${Bun.randomUUIDv7()}::uuid,${other}::uuid,NULL,NULL,${sha},'foreign.txt','text/plain','file',${privateBytes.length})`;
    yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance) VALUES
      (${bot}::uuid,${owner}::uuid,'bot',jsonb_build_object('workerId',${worker}::text),'codex','native'),
      (${foreignBot}::uuid,${other}::uuid,'foreign','{}','codex','native')`;
    yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input)
      VALUES(${Bun.randomUUIDv7()}::uuid,${bot}::uuid,'bot-turn','private prompt fixture'),
      (${Bun.randomUUIDv7()}::uuid,${foreignBot}::uuid,'other-turn','foreign prompt fixture')`;
    yield* sql`INSERT INTO schedules(id,thread_id,project_id,kind,prompt,run_at,next_run_at,created_by_user_id,lease_until)
      VALUES(${schedule}::uuid,${thread}::uuid,${project}::uuid,'once','private prompt fixture',
        now(),now(),${owner}::uuid,now()+interval '1 hour')`;
    yield* sql`INSERT INTO schedules(id,project_id,target,new_thread,status,kind,prompt,run_at,created_by_user_id)
      VALUES(${newThreadSchedule}::uuid,${project}::uuid,'new_thread',jsonb_build_object('workspaceId',${workspace}::text),
        'paused','once','private prompt fixture',now(),${owner}::uuid)`;
    yield* sql`INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,expires_at)
      VALUES(${Bun.randomUUIDv7()}::uuid,${worker}::uuid,${thread}::uuid,'startTurn',${privateBytes},now()+interval '1 hour')`;
    yield* sql`INSERT INTO worker_commands(id,worker_id,kind,payload,expires_at)
      VALUES(${Bun.randomUUIDv7()}::uuid,${foreignWorker}::uuid,'runBotTurn',${privateBytes},now()+interval '1 hour')`;

    return {
      owner,
      other,
      worker,
      sharedWorker,
      project,
      workspace,
      thread,
      side,
      moved,
      deleted,
      bot,
      attachment,
      schedule,
      newThreadSchedule,
      move,
      node,
      peer,
      relay,
      remoteParentRef,
    };
  });
}

test.skipIf(!dockerAvailable)(
  "consolidation preflight inventories one source without adopting mirrors or other owners",
  async () => {
    const pg = await startPostgres({ migrated: true });
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      const f = await runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.withTransaction(seed(sql))));
      const preflight = consolidationPreflight(f.owner);
      const result = await runtime.runPromise(preflight);
      expect(result.source).toEqual({ nodeId: f.node, ownerUserId: f.owner, name: "Source" });
      expect(result.home.projects.map((p) => p.id)).toEqual([f.project]);
      expect(result.home.threads.map((t) => t.id)).toEqual([f.thread, f.side, f.deleted].sort());
      expect(result.home.threads.find((t) => t.id === f.thread)).toMatchObject({
        workerId: f.worker,
        workspaceId: f.workspace,
        projectId: f.project,
        hasProviderSession: true,
        key: [f.node, f.owner, "thread", f.thread],
      });
      expect(result.home.threads.find((t) => t.id === f.side)).toMatchObject({
        parentThreadId: f.thread,
        rootThreadId: f.thread,
        remoteParentRef: f.remoteParentRef,
        remoteParentKind: "thread",
      });
      expect(result.home.threads.find((t) => t.id === f.deleted)?.deleted).toBe(true);
      expect(result.home.bots).toEqual([
        {
          id: f.bot,
          workerId: f.worker,
          key: [f.node, f.owner, "bot", f.bot],
          archived: false,
          deleted: false,
        },
      ]);
      expect(result.home.schedules).toMatchObject([
        { id: f.schedule, threadId: f.thread, projectId: f.project, workspaceId: null },
        { id: f.newThreadSchedule, threadId: null, projectId: f.project, workspaceId: f.workspace },
      ]);
      expect(result.home.attachments).toEqual([
        { id: f.attachment, threadId: f.thread, botId: null, key: [f.node, f.owner, "attachment", f.attachment] },
      ]);
      expect(result.home.workers.map(({ id, revoked }) => ({ id, revoked }))).toEqual([
        { id: f.worker, revoked: true },
      ]);
      expect(result.sharedWorkers.map((w) => w.id)).toEqual([f.sharedWorker]);
      expect(result.peers).toEqual([
        {
          nodeId: f.peer,
          name: "Peer",
          viaNodeId: null,
          lastKnownStatus: "unreachable",
          mirroredThreads: 1,
          mirroredBots: 1,
          mirroredWorkers: 1,
        },
        {
          nodeId: f.relay,
          name: "Relayed",
          viaNodeId: f.peer,
          lastKnownStatus: "unreachable",
          mirroredThreads: 0,
          mirroredBots: 0,
          mirroredWorkers: 0,
        },
      ]);
      expect(result.redirects).toEqual([
        { kind: "thread", itemId: f.moved, fromNodeId: f.node, homeNodeId: f.peer, basis: "local_move" },
      ]);
      expect(result.blockers).toEqual([
        { kind: "bot", id: f.bot, reason: "active_work" },
        { kind: "bot", id: f.bot, reason: "worker_unavailable" },
        { kind: "move", id: f.move, reason: "unfinished_move" },
        { kind: "schedule", id: f.schedule, reason: "leased" },
        { kind: "thread", id: f.thread, reason: "active_work" },
        { kind: "thread", id: f.thread, reason: "commands_pending" },
        { kind: "thread", id: f.thread, reason: "worker_unavailable" },
        { kind: "thread", id: f.side, reason: "worker_unavailable" },
      ]);
      expect(JSON.stringify(result)).not.toMatch(/private|certificate|credential|fingerprint|Foreign/);
      expect(await runtime.runPromise(preflight)).toEqual(result);
      await expect(runtime.runPromise(consolidationPreflight(f.other))).rejects.toThrow(
        "Linked computer identity not found",
      );
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
