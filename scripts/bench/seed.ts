import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export const ids = {
  owner: "10000000-0000-4000-8000-000000000001",
  worker: "20000000-0000-4000-8000-000000000001",
  thread: "30000000-0000-4000-8000-000000000001",
};

export interface Dataset {
  readonly threads: number;
  readonly turns: number;
  readonly textBytes: number;
  readonly longTurns: number;
  readonly agentTail: number;
}

export const seed = (size: Dataset) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO users(id,email,display_name,role) VALUES
    (${ids.owner}::uuid,'benchmark@example.invalid','Benchmark','user')`;
    yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash,os,capabilities)
    VALUES (${ids.worker}::uuid,${ids.owner}::uuid,'Benchmark worker','synthetic','linux',
      '{"scratchRoot":"/benchmark/scratch"}')`;
    yield* sql`INSERT INTO worker_configs(worker_id,version,config,updated_by) VALUES (${ids.worker}::uuid,1,'{}',${ids.owner}::uuid)`;
    yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash,os,capabilities)
      SELECT md5('worker-'||n)::uuid,${ids.owner}::uuid,'Worker '||n,'synthetic','linux',
        jsonb_build_object('scratchRoot','/benchmark/scratch-'||n) FROM generate_series(1,12) n`;
    yield* sql`INSERT INTO worker_configs(worker_id,version,config,updated_by)
      SELECT id,1,'{}',${ids.owner}::uuid FROM workers WHERE id<>${ids.worker}::uuid`;
    yield* sql`INSERT INTO projects(id,owner_user_id,name,slug)
    SELECT md5('project-'||n)::uuid,${ids.owner}::uuid,'Project '||n,'bench-'||n FROM generate_series(1,24) n`;
    yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path)
    SELECT md5('workspace-'||n)::uuid,md5('project-'||n)::uuid,${ids.worker}::uuid,'/benchmark/project-'||n
    FROM generate_series(1,24) n`;
    yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,
      worker_id,workspace_id,cwd,status,title,provider_thread_id,last_seq)
    SELECT id,md5('project-'||project)::uuid,${ids.owner}::uuid,'main',id,'worker','codex',
      ${ids.worker}::uuid,md5('workspace-'||project)::uuid,'/benchmark/project-'||project,
      'idle','Benchmark thread '||n,'bench-'||n,${size.turns * 2}
    FROM (SELECT n,1+(n%24) AS project,CASE WHEN n=1 THEN ${ids.thread}::uuid
      ELSE md5('thread-'||n)::uuid END AS id FROM generate_series(1,${size.threads}) n) t`;

    // Batch each thread separately so deferred journal triggers have bounded memory and transaction duration.
    for (let n = 1; n <= size.threads; n++) {
      const thread = n === 1 ? ids.thread : undefined;
      const turns = n === 1 ? size.longTurns : size.turns;
      const userThrough = Math.max(1, turns - size.agentTail);
      yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq,
        queued_at,started_at,completed_at)
      SELECT md5('turn-'||${n}||'-'||i)::uuid,coalesce(${thread ?? null}::uuid,md5('thread-'||${n})::uuid),
        i,'completed',CASE WHEN i<=${userThrough} THEN 'user' ELSE 'provider' END,
        CASE WHEN i<=${userThrough} THEN ${ids.owner}::uuid END,
        jsonb_build_object('text','Synthetic task '||i),i*2-1,i*2,
        now()-(i||' minutes')::interval,now()-(i||' minutes')::interval,now()-(i||' minutes')::interval
      FROM generate_series(1,${turns}) i`;
      yield* sql`INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
      SELECT u.thread_id,'answer-'||ordinal,u.id,'agent_message','completed',
        jsonb_build_object('itemId','answer-'||ordinal,'status','ITEM_STATUS_COMPLETED',
          'agentMessage',jsonb_build_object('text',
            (SELECT string_agg(md5(u.id::text||'-'||g),'') FROM generate_series(1,${Math.ceil(size.textBytes / 32)}) g))),
        ordinal*2-1,ordinal*2 FROM turns u
      WHERE u.thread_id=coalesce(${thread ?? null}::uuid,md5('thread-'||${n})::uuid)`;
    }

    yield* sql`INSERT INTO thread_events(thread_id,seq,event_id,origin,turn_id,kind,item_id,payload,occurred_at)
    SELECT thread_id,last_seq,md5('event-'||turn_id)::uuid,'worker',turn_id,'item_completed',item_id,
      jsonb_build_object('threadId',thread_id,'itemCompleted',content),now() FROM thread_items`;
    yield* sql`INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
    SELECT ${ids.thread}::uuid,'bg:'||n,'background_task','in_progress',
      jsonb_build_object('itemId','bg:'||n,'status','ITEM_STATUS_IN_PROGRESS',
        'backgroundTask',jsonb_build_object('taskId','task-'||n,'description','Synthetic background task')),
      ${size.longTurns * 2}+n,${size.longTurns * 2}+n FROM generate_series(1,64) n`;
    yield* sql`UPDATE threads SET last_seq=${size.longTurns * 2 + 64} WHERE id=${ids.thread}::uuid`;
    yield* seedExtras(sql, size);
    yield* sql`ANALYZE`;
  });

function seedExtras(sql: SqlClient.SqlClient, size: Dataset) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
      VALUES (${ids.owner}::uuid,'benchmark-peer','Benchmark peer','synthetic','synthetic')`;
    yield* sql`INSERT INTO blobs(sha256,size_bytes,mime_type,data)
      VALUES (${"a".repeat(64)},16,'text/plain',${Buffer.alloc(16)})`;
    yield* sql`INSERT INTO attachments(id,owner_user_id,sha256,name,mime_type,kind,size_bytes)
      SELECT md5('attachment-'||n)::uuid,${ids.owner}::uuid,${"a".repeat(64)},'attachment-'||n,
        'text/plain','file',16 FROM generate_series(1,${size.threads}) n`;
    yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
      SELECT md5('bot-'||n)::uuid,${ids.owner}::uuid,'bench-'||n,'{}','codex','native'
      FROM generate_series(1,16) n`;
    yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input,status,finished_at)
      SELECT md5('bot-turn-'||b.id||'-'||n)::uuid,b.id,'bench-'||n,'Synthetic task','completed',now()
      FROM bots b CROSS JOIN generate_series(1,${size.turns}) n`;
    yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,text)
      SELECT md5('bot-message-'||id)::uuid,bot_id,id,'reply','agent','user',repeat(md5(id::text),128) FROM bot_turns`;
    yield* sql`INSERT INTO schedules(id,thread_id,project_id,kind,prompt,run_at,next_run_at,created_by_user_id)
      SELECT md5('schedule-'||id)::uuid,id,project_id,'once','Synthetic scheduled task',now()+interval '1 day',
        now()+interval '1 day',${ids.owner}::uuid FROM threads`;
  });
}
