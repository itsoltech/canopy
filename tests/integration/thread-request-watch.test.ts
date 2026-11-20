import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { InteractionKind, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Code } from "@connectrpc/connect";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread request watch", () => {
  let gateway: TestGateway;
  let store: ComputerStore;
  let thread: string;
  let turn: string;

  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 100 });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    gateway.worker.holdTurns = true;
    const projectId = (await gateway.api.createProject({ name: "Request projections" })).project!.id;

    const workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo" })
    ).workspace!.id;

    thread = (
      await gateway.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, initialMessage: "Work" })
    ).thread!.id;
    turn = (
      await eventually(
        () =>
          store.query<{ id: string }>("SELECT id FROM turns WHERE thread_id=$1::uuid AND status='running'", [thread]),
        (rows) => rows.length === 1,
      )
    )[0]!.id;
    await store.query(
      `INSERT INTO thread_items(thread_id,turn_id,item_id,type,status,first_seq,last_seq,content)
       SELECT $1::uuid,$2::uuid,'cmd-' || n,'command_execution','completed',n,n,jsonb_build_object(
         'itemId','cmd-' || n,'commandExecution',jsonb_build_object('command','review','output',repeat('x',32768),
         'outputBlob',jsonb_build_object('sha256',repeat('a',64)))) FROM generate_series(1,384) n`,
      [thread, turn],
    );
    await store.query("UPDATE threads SET last_seq=384 WHERE id=$1::uuid", [thread]);
  }, 30_000);

  afterAll(async () => gateway?.close());

  function watch(id: string, controller: AbortController) {
    return gateway.api
      .watchThread(
        { threadId: id, requestsOnly: true, sequence: true, pageSize: 1 },
        { signal: controller.signal, timeoutMs: 10_000 },
      )
      [Symbol.asyncIterator]();
  }

  async function snapshot(reader: ReturnType<typeof watch>, matches: (snapshot: ui.ThreadSnapshot) => boolean) {
    for (;;) {
      const update = await reader.next();

      if (update.done || update.value.change.case !== "snapshot") throw new Error("Expected a request snapshot");
      expect(toBinary(ui.ThreadUpdateSchema, update.value).length).toBeLessThan(4096);
      const state = update.value.change.value;
      expect(state.turns).toHaveLength(0);
      expect(state.notices).toHaveLength(0);
      expect(state.syncCursor).toBeUndefined();

      if (matches(state)) return state;
    }
  }

  test("streams pending async questions and only their approval details across updates and reconnect", async () => {
    const question = crypto.randomUUID();
    const permission = crypto.randomUUID();
    const file = crypto.randomUUID();

    const asked = await gateway.worker.callTool({
      threadId: thread,
      turnId: turn,
      tool: "ask_user",
      callId: question,
      args: { wait: false, questions: [{ id: "q", header: "Review", kind: "text", question: "Review notes?" }] },
    });

    expect(asked.isError).toBe(false);
    const abort = new AbortController();
    const reader = watch(thread, abort);

    try {
      const initial = await snapshot(reader, () => true);
      expect(initial.interactions).toMatchObject([{ requestId: question, asynchronous: true }]);
      expect(initial.items).toHaveLength(0);
      const request = { threadId: thread, turnId: turn, kind: InteractionKind.PERMISSION, requestJson: "{}" };
      gateway.worker.ask({ ...request, requestId: permission, itemId: "cmd-1", toolName: "shell" });
      gateway.worker.ask({ ...request, requestId: file, itemId: "patch", toolName: "edit" });
      const pending = await snapshot(reader, (state) => state.interactions.length === 3);
      expect(pending.items).toHaveLength(1);
      expect(pending.items[0]?.item?.content).toMatchObject({
        case: "commandExecution",
        value: { command: "review", output: "" },
      });
      expect(pending.items[0]?.item?.content.value).not.toHaveProperty("outputBlob");
      const diff = "@@ -1 +1 @@\n-old\n+new";

      gateway.worker.emit(thread, turn, {
        case: "itemStarted",
        value: {
          item: {
            itemId: "patch",
            status: ItemStatus.IN_PROGRESS,
            content: { case: "fileChange", value: { changes: [{ path: "file", kind: "update", diff }] } },
          },
        },
      });
      const changed = await snapshot(reader, (state) => state.items.length === 2);
      expect(changed.items.at(-1)?.item?.content).toMatchObject({
        case: "fileChange",
        value: { changes: [{ path: "file", diff }] },
      });
      await gateway.api.answerInteraction({ requestId: permission, cancelled: true });
      const remaining = await snapshot(reader, (state) => state.interactions.every((q) => q.requestId !== permission));
      expect(remaining.items.map((i) => i.item?.itemId)).toEqual(["patch"]);
    } finally {
      abort.abort();
      await reader.return?.();
    }

    await gateway.api.answerInteraction({ requestId: file, cancelled: true });
    const resume = new AbortController();
    const reconnected = watch(thread, resume);

    try {
      const state = await snapshot(reconnected, () => true);
      expect(state.interactions.map((q) => q.requestId)).toEqual([question]);
      expect(state.items).toHaveLength(0);
    } finally {
      resume.abort();
      await reconnected.return?.();
    }
  }, 20_000);

  test("denies another owner's thread even when its item ID matches an approval", async () => {
    const owner = crypto.randomUUID();
    const privateThread = crypto.randomUUID();
    const project = crypto.randomUUID();
    await store.query("INSERT INTO users(id,email,display_name,role) VALUES($1,$2,'Owner','user')", [
      owner,
      owner + "@test",
    ]);
    await store.query("INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1,$2,'Private','private')", [
      project,
      owner,
    ]);
    await store.query(
      `INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,status)
       VALUES($1,$2,$3,'main',$1,'gateway','openai','idle')`,
      [privateThread, project, owner],
    );
    await store.query(
      `INSERT INTO interaction_requests(id,thread_id,item_id,kind,tool_name,request,routed_to)
       VALUES(gen_random_uuid(),$1,'cmd-1','permission','shell','{}','human')`,
      [privateThread],
    );
    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,first_seq,last_seq,content)
       VALUES($1,'cmd-1','command_execution','completed',1,1,
         '{"itemId":"cmd-1","commandExecution":{"command":"private"}}')`,
      [privateThread],
    );
    const abort = new AbortController();
    const reader = watch(privateThread, abort);

    try {
      await expect(reader.next()).rejects.toMatchObject({ code: Code.NotFound });
    } finally {
      abort.abort();
      await reader.return?.();
    }

    const local = new AbortController();
    const watching = watch(thread, local);
    const localRequest = crypto.randomUUID();

    try {
      await snapshot(watching, () => true);
      // No local hub notification: another gateway committed this request.
      await store.query(
        `INSERT INTO interaction_requests(id,thread_id,item_id,kind,tool_name,request,routed_to)
         VALUES($1,$2,'cmd-1','permission','shell','{}','human')`,
        [localRequest, thread],
      );
      const visible = await snapshot(watching, (state) => state.interactions.some((q) => q.requestId === localRequest));
      expect(visible.interactions.every((q) => q.threadId === thread)).toBe(true);
      expect(visible.items.map((i) => i.item?.content)).toMatchObject([
        { case: "commandExecution", value: { command: "review", output: "" } },
      ]);
    } finally {
      local.abort();
      await watching.return?.();
      await store.query("DELETE FROM interaction_requests WHERE id=$1", [localRequest]);
    }
  });
});
