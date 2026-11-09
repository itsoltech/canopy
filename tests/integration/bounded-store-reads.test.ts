import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { authorizeBusCall } from "@canopy/domain";
import { dockerAvailable } from "@canopy/db/testing";
import { AgentBusStore, GatewayStore, InstanceStore, truncate } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { watchTexts } from "../../apps/gateway/src/bots/store-wakeups.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bounded history and notification reads", () => {
  let gateway: TestGateway;
  let thread: string;
  const query = (sql: string, args: unknown[] = []) => gateway.core.linkedAgents.query(sql, args);
  beforeAll(async () => {
    gateway = await startTestGateway();
    const project = (await gateway.api.createProject({ name: "Bounded reads" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/bounded" })
    ).workspace!.id;

    thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("batched UUID aliases preserve owned targets without authorizing another owner's thread", async () => {
    const own = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    const other = crypto.randomUUID();
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other','user')", [
      other,
      `${other}@example.test`,
    ]);
    await query("INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$1::uuid,'Other','other')", [other]);
    await query(
      `INSERT INTO threads(id,root_thread_id,project_id,owner_user_id,kind,runtime,provider,status)
      SELECT $1::uuid,$1::uuid,project_id,owner_user_id,'main','gateway','anthropic','idle' FROM threads WHERE id=$2::uuid
      UNION ALL SELECT $3::uuid,$3::uuid,$4::uuid,$4::uuid,'main','gateway','anthropic','idle'`,
      [own, thread, foreign, other],
    );
    const ids = [own, own.toUpperCase(), foreign.toUpperCase()];

    const { facts } = await gateway.runtime.runPromise(
      AgentBusStore.use((s) =>
        s.facts({
          source: { callId: crypto.randomUUID(), threadId: thread, turnId: "", itemId: "" },
          targetIds: [...ids, "invalid"],
        }),
      ),
    );

    for (const id of ids.slice(0, 2)) {
      expect(facts.targets.get(id)?.id).toBe(own);
      expect(authorizeBusCall({ tool: "get_thread", args: { thread_id: id } }, facts).allowed).toBe(true);
    }

    expect(facts.targets.get(foreign.toUpperCase())?.ownerId).toBe(other);
    expect(authorizeBusCall({ tool: "get_thread", args: { thread_id: foreign.toUpperCase() } }, facts).allowed).toBe(
      false,
    );
    expect(facts.targets.has("invalid")).toBe(false);
  });

  const turn = async (ordinal: number) => {
    const id = crypto.randomUUID();
    await query(
      "INSERT INTO turns(id,thread_id,ordinal,trigger,author_user_id,input,status,first_seq,last_seq,completed_at) VALUES($1::uuid,$2::uuid,$3,'user',$4::uuid,'{}','completed',$3,$3,now())",
      [id, thread, ordinal, gateway.userId],
    );

    return id;
  };

  test("branch context preserves the first and latest three nonempty requests, without duplicates", async () => {
    expect((await gateway.runtime.runPromise(GatewayStore.use((s) => s.branchContext(thread)))).requests).toEqual([]);
    const all: string[] = [];

    for (let ordinal = 1; ordinal <= 7; ordinal++) {
      const id = await turn(ordinal);
      const text = `request-${ordinal}`;
      await query("UPDATE turns SET input=jsonb_build_object('text',$2::text) WHERE id=$1::uuid", [id, text]);
      all.push(text);
      const result = await gateway.runtime.runPromise(GatewayStore.use((s) => s.branchContext(thread)));
      expect(result.requests).toEqual([...all.slice(0, 1), ...all.slice(1).slice(-3)]);
    }

    const empty = await turn(8);
    await query("UPDATE turns SET input='{}'::jsonb WHERE id=$1::uuid", [empty]);
    expect((await gateway.runtime.runPromise(GatewayStore.use((s) => s.branchContext(thread)))).requests).toEqual([
      "request-1",
      "request-5",
      "request-6",
      "request-7",
    ]);
  });

  test("watch result excludes tool blobs and preserves newlines and UTF-16 prefix semantics", async () => {
    const id = await turn(9);
    await query(
      `INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
      VALUES($1::uuid,'large-tool',$2::uuid,'tool_call','completed',jsonb_build_object('toolCall',jsonb_build_object('output',repeat('x',1000000))),100,100),
      ($1::uuid,'first-answer',$2::uuid,'agent_message','completed',jsonb_build_object('agentMessage',jsonb_build_object('text',repeat('a',79999))),101,101),
      ($1::uuid,'next-answer',$2::uuid,'agent_message','completed','{"agentMessage":{"text":"next"}}',102,102)`,
      [thread, id],
    );

    const read = () =>
      gateway.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return (yield* watchTexts(sql, [{ thread, turn: id }])).get(id);
        }),
      );

    expect(await read()).toBe("a".repeat(79999) + "\n");
    const unicode = "😀".repeat(39999) + "a";
    await query(
      "UPDATE thread_items SET content=jsonb_build_object('agentMessage',jsonb_build_object('text',$3::text)) WHERE thread_id=$1::uuid AND item_id=$2",
      [thread, "first-answer", unicode],
    );
    expect(await read()).toBe((unicode + "\nnext").slice(0, 80000));
  });

  test("notification keysets cover every row after terminal cursor changes with bounded text and projection", async () => {
    const id = await turn(10);
    await query(
      `INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
      VALUES($1::uuid,'notification-answer',$2::uuid,'agent_message','completed',jsonb_build_object('agentMessage',jsonb_build_object('text',repeat('a',30000))),103,103)`,
      [thread, id],
    );
    await query(
      `INSERT INTO agent_bus_calls(id,source_thread_id,tool,arguments,status,target_thread_id,target_turn_id,hops,notify,notify_status,completed_at)
      SELECT md5('bounded-notification-'||n)::uuid,$1::uuid,'send_message',jsonb_build_object('large',repeat('x',10000)),
      'completed',$1::uuid,$2::uuid,1,true,'pending',now() FROM generate_series(1,150)n`,
      [thread, id],
    );

    const page = (after?: string) =>
      gateway.runtime.runPromise(AgentBusStore.use((s) => s.dueNotifications(id, after)));

    const first = await page();
    expect(first).toHaveLength(50);
    expect(first[0]?.lastMessage).toHaveLength(20001);
    expect(first[0]?.lastMessageLength).toBe(30000);
    expect(first[0]?.call).not.toHaveProperty("arguments");
    await query("UPDATE agent_bus_calls SET notify_status='superseded' WHERE id=$1::uuid", [first.at(-1)!.call.id]);
    const second = await page(first.at(-1)!.call.id);
    const third = await page(second.at(-1)!.call.id);
    expect(new Set([...first, ...second, ...third].map((n) => n.call.id)).size).toBe(150);
    expect(await page(third.at(-1)!.call.id)).toEqual([]);
    await query(
      "UPDATE thread_items SET content=jsonb_build_object('agentMessage',jsonb_build_object('text',repeat('😀',30000))) WHERE thread_id=$1::uuid AND item_id='notification-answer'",
      [thread],
    );
    const unicode = (await page())[0]!;
    expect(unicode.lastMessageLength).toBe(60000);
    expect(truncate(unicode.lastMessage, 20000, unicode.lastMessageLength)).toBe(
      "😀".repeat(10000) + "… [40000 more characters]",
    );
  });

  test("batched secret references keep values encrypted at rest and resolve duplicate references", async () => {
    const secret = await gateway.runtime.runPromise(
      GatewayStore.use((s) =>
        s.putSecret({
          ownerUserId: gateway.userId,
          name: "synthetic-batch-secret",
          plaintext: "synthetic-value",
          createdBy: gateway.userId,
        }),
      ),
    );

    await gateway.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          gateway.workerId,
          {
            profiles: [{ id: "batch-a" }, { id: "batch-b" }],
          },
          gateway.userId,
          { "batch-a": secret, "batch-b": secret },
        ),
      ),
    );
    const config = await gateway.runtime.runPromise(GatewayStore.use((s) => s.workerConfig(gateway.workerId)));
    expect(config?.profiles.map((p) => p.apiKey)).toEqual(["synthetic-value", "synthetic-value"]);
    const stored = await query("SELECT config::text FROM worker_configs WHERE worker_id=$1::uuid", [gateway.workerId]);
    expect(JSON.stringify(stored)).not.toContain("synthetic-value");
    expect(
      (await query("SELECT secret_id FROM worker_config_secrets WHERE worker_id=$1::uuid", [gateway.workerId])).length,
    ).toBe(1);
  });

  test("provider settings omit another owner's instances and worker assignments", async () => {
    const other = crypto.randomUUID();
    const worker = crypto.randomUUID();
    await query(
      "INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,'settings-other@example.invalid','Other','user')",
      [other],
    );
    await query(
      "INSERT INTO workers(id,name,credential_hash,owner_user_id) VALUES($1::uuid,'private-worker','synthetic-settings-hash',$2::uuid)",
      [worker, other],
    );
    await query(
      `INSERT INTO provider_instances(harness,id,kind,label,created_by,env)
      VALUES('codex','private-settings','native','Private',$1::uuid,
        jsonb_build_array(jsonb_build_object('name','PRIVATE_SETTING','value',repeat('x',65536))))`,
      [other],
    );
    await query(
      `INSERT INTO provider_instance_workers(harness,instance_id,worker_id,enabled)
      VALUES('codex','native',$1::uuid,true),('codex','private-settings',$1::uuid,true)`,
      [worker],
    );

    const listed = await gateway.runtime.runPromise(InstanceStore.use((s) => s.list(gateway.userId)));
    expect(listed.some((i) => i.id === "private-settings")).toBe(false);
    expect(listed.flatMap((i) => i.workers).some((w) => w.workerId === worker)).toBe(false);
    expect(
      listed
        .find((i) => i.harness === Provider.CODEX && i.id === "native")
        ?.workers.some((w) => w.workerId === gateway.workerId),
    ).toBe(true);

    const privateView = await gateway.runtime.runPromise(InstanceStore.use((s) => s.list(other)));
    expect(privateView.find((i) => i.id === "private-settings")?.workers.map((w) => w.workerId)).toEqual([worker]);
  });
});
