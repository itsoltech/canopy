import { Provider } from "@canopy/contracts";
import type { TestGateway } from "./gateway.ts";

/** Persisted chat with an old approval-heavy thread, recent conversation and a routine's message_user output. */
export async function seedBotChatHistory(gateway: TestGateway) {
  const query = (sql: string, params: unknown[] = []) => gateway.core.linkedAgents.query(sql, params);

  const bot = (
    await gateway.api.createBot({
      configuration: {
        name: "Learning",
        shape: "round",
        color: "#e34a4a",
        provider: Provider.CODEX,
        providerInstance: "native",
        model: "gpt-6.1-sol",
      },
      clientRequestId: crypto.randomUUID(),
    })
  ).bot!.id;

  const project = (await gateway.api.createProject({ name: "Lessons" })).project!.id;

  const workspace = (
    await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/lessons" })
  ).workspace!.id;

  const thread = (
    await gateway.api.createThread({
      projectId: project,
      workspaceId: workspace,
      provider: Provider.CODEX,
      title: "Lesson HTML",
      clientRequestId: crypto.randomUUID(),
    })
  ).thread!.id;

  await query("INSERT INTO bot_started_threads(thread_id,bot_id) VALUES($1::uuid,$2::uuid)", [thread, bot]);
  await query(
    `INSERT INTO interaction_requests(id,thread_id,kind,tool_name,request,status,routed_to,answered_by,answered_at,created_at)
    SELECT gen_random_uuid(),$1::uuid,'permission','Bash','{"command":"git status --short"}'::jsonb,
      'allowed','human',$2::uuid,now()-interval '1 hour',now()-interval '2 hours'+n*interval '1 second'
    FROM generate_series(1,105) n`,
    [thread, gateway.userId],
  );
  await query(
    `INSERT INTO bot_turns(id,bot_id,client_request_id,input,status)
    SELECT gen_random_uuid(),$1::uuid,'history-'||n,'Question '||n,'completed' FROM generate_series(1,60) n`,
    [bot],
  );
  await query(
    `INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,text,created_at)
    SELECT gen_random_uuid(),bot_id,id,'answer',
      CASE WHEN n%2=0 THEN bot_id::text ELSE 'user' END,
      CASE WHEN n%2=0 THEN 'user' ELSE bot_id::text END,'Message '||n,
      now()-interval '30 minutes'+n*interval '1 second'
    FROM (SELECT *,substring(client_request_id FROM 9)::int AS n FROM bot_turns WHERE bot_id=$1::uuid) t
    ORDER BY n`,
    [bot],
  );
  const routine = crypto.randomUUID();
  const turn = crypto.randomUUID();
  await query(
    `INSERT INTO bot_routines(id,bot_id,title,instructions,cron,schedule_text,hops,next_run_at,last_outcome)
    VALUES($1::uuid,$2::uuid,'Morning brief','Send a brief','30 8 * * 1-5','At 08:30',1,
      now()+interval '1 day','Sent you a message')`,
    [routine, bot],
  );
  await query(
    `INSERT INTO bot_turns(id,bot_id,client_request_id,input,status,routine_id,routine_title)
    VALUES($1::uuid,$2::uuid,'morning-brief','Check lessons','completed',$3::uuid,'Morning brief')`,
    [turn, bot, routine],
  );
  await query(
    `INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,text)
    VALUES(gen_random_uuid(),$1::uuid,$2::uuid,'user:brief',$1,'user','Morning brief: lessons are ready')`,
    [bot, turn],
  );

  return { bot, thread };
}
