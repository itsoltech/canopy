import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { InteractionKind, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { parseObject, str } from "@canopy/domain/json";
import { answerText } from "@canopy/domain/questions";
import { SqlClient } from "effect/sql";
import { answerQuestions, mobileQuestions } from "../../apps/mobile/src/api/questions.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { SERVICE_TOKEN, eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

const questions = [
  {
    id: "direction",
    header: "Direction",
    question: "Which direction?",
    kind: "single_choice",
    options: [{ label: "North", description: "Keep the current route" }, { label: "South" }],
    recommended: "North",
  },
  {
    id: "extras",
    header: "Extras",
    question: "Which extras?",
    kind: "multiple_choice",
    options: [{ label: "Map" }, { label: "Compass" }],
  },
  { id: "notes", header: "Notes", question: "Any notes?", kind: "text" },
  { id: "optional", header: "Optional", question: "Anything else?", kind: "text" },
];

describe.skipIf(!dockerAvailable)("mobile answers over paired Network access", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let token = "";
  let projectId = "";
  let workspaceId = "";
  const transport = nodePinnedTransport();

  const client = (deviceToken = token) =>
    routedMobileClient({
      connection: gw.core.mobile.networkRoutes(),
      token: deviceToken,
      transport,
    }).api;

  const query = <A extends object>(statement: string, ...params: string[]) =>
    gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(statement, params)));

  async function mount() {
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
  }

  async function pair() {
    const invitation = await gw.api.createMobilePairing({});
    const phone = routedMobileClient({ connection: gw.core.mobile.networkRoutes(), transport });

    return phone.pairing.exchangeMobilePairing({ code: invitation.code, name: "Question phone", platform: "android" });
  }

  async function snapshot(threadId: string) {
    const updates = await watchUntil(client(), threadId, (u) => u.some((v) => v.change.case === "snapshot"));
    const snapshot = updates.find((u) => u.change.case === "snapshot");

    if (snapshot?.change.case !== "snapshot") throw new Error("Missing phone snapshot");

    return snapshot.change.value;
  }

  async function start(title = "Mobile questions") {
    gw.worker.holdTurns = true;

    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title,
        initialMessage: "Ask questions",
      })
    ).thread!;

    const state = await eventually(
      () => snapshot(thread.id),
      (s) => s.turns.some((t) => t.status === "running"),
    );

    return { threadId: thread.id, turnId: state.turns.find((t) => t.status === "running")!.id };
  }

  async function ask(tool: string, source: { threadId: string; turnId: string }, wait = false) {
    const requestId = Bun.randomUUIDv7();

    if (tool === "ask_user")
      await gw.worker.callTool({ ...source, callId: requestId, tool, args: { questions, wait } });
    else
      gw.worker.ask({
        ...source,
        requestId,
        kind: InteractionKind.QUESTION,
        toolName: tool,
        requestJson: JSON.stringify(
          tool === "AskUserQuestion"
            ? {
                input: {
                  questions: questions.map((q) => ({
                    header: q.header,
                    question: q.question,
                    options: q.options ?? [{ label: "Default" }, { label: "Custom" }],
                    multiSelect: q.kind === "multiple_choice",
                  })),
                },
              }
            : { questions },
        ),
      });

    const state = await eventually(
      () => snapshot(source.threadId),
      (s) => s.interactions.some((q) => q.requestId === requestId),
    );

    const interaction = state.interactions.find((q) => q.requestId === requestId)!;
    expect(mobileQuestions(interaction)).toHaveLength(4);

    return interaction;
  }

  async function answered(interaction: ui.Interaction, expected: string[]) {
    const state = await eventually(
      () => snapshot(interaction.threadId),
      (s) =>
        s.items.some(
          (entry) =>
            entry.item?.content.case === "interactionPrompt" &&
            entry.item.content.value.requestId === interaction.requestId &&
            Boolean(entry.item.content.value.outcome),
        ),
    );

    const item = state.items.find(
      (entry) =>
        entry.item?.content.case === "interactionPrompt" &&
        entry.item.content.value.requestId === interaction.requestId,
    )?.item;

    expect(item?.content.case).toBe("interactionPrompt");

    if (item?.content.case !== "interactionPrompt") throw new Error("Missing question timeline record");
    const prompt = item.content.value;
    expect(prompt.outcome).toBe("answered");
    expect(prompt.answeredByUserId).toBe(gw.userId);
    expect(mobileQuestions(interaction).map((q) => answerText(prompt.responseJson, q))).toEqual(expected);
    expect(state.interactions.some((q) => q.requestId === interaction.requestId)).toBe(false);
  }

  beforeAll(async () => {
    gw = await startTestGateway();
    await mount();
    token = (await pair()).deviceToken;
    projectId = (await gw.api.createProject({ name: "Mobile questions" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);
  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  for (const tool of ["AskUserQuestion", "request_user_input", "ask_user"]) {
    test(`${tool}: choices, multi-select, custom text and explicit skip reach the worker and timeline`, async () => {
      const source = await start();
      const interaction = await ask(tool, source);
      const q = mobileQuestions(interaction);

      if (tool === "ask_user")
        await expect(
          answerQuestions(
            client(),
            interaction,
            q.map((question) => ({ id: question.id, kind: "choice", labels: ["Invalid option"] })),
          ),
        ).rejects.toMatchObject({ code: Code.InvalidArgument });
      await answerQuestions(client(), interaction, [
        { id: q[0]!.id, kind: "choice", labels: ["North"] },
        { id: q[1]!.id, kind: "choice", labels: ["Map", "Compass"] },
        { id: q[2]!.id, kind: "text", text: "Take the scenic route" },
        { id: q[3]!.id, kind: "skipped" },
      ]);
      await answered(interaction, ["North", "Map, Compass", "Take the scenic route", "Skipped"]);

      if (tool !== "ask_user") {
        const response = await eventually(
          async () => gw.worker.interactionResponses.get(interaction.requestId),
          Boolean,
        );

        expect(response?.cancelled).toBe(false);
        expect(parseObject(response!.answerJson)).toEqual(
          tool === "AskUserQuestion"
            ? {
                "Which direction?": "North",
                "Which extras?": "Map, Compass",
                "Any notes?": "Take the scenic route",
                "Anything else?": "",
              }
            : {
                direction: { answers: ["North"] },
                extras: { answers: ["Map", "Compass"] },
                notes: { answers: ["Take the scenic route"] },
                optional: { answers: [] },
              },
        );
      } else
        expect(
          str(
            parseObject(
              (
                await gw.worker.callTool({
                  ...source,
                  tool: "get_answers",
                  args: { question_set_id: interaction.requestId },
                })
              ).content,
            )["status"],
          ),
        ).toBe("answered");
      gw.worker.finish(source.threadId, source.turnId);
    }, 20_000);
  }

  test("additional question tools and long question sets use the shared answer contract", async () => {
    const source = await start();
    const requestId = Bun.randomUUIDv7();

    const extended = [
      ...questions,
      { id: "fifth", question: "Fifth answer?" },
      { id: "sixth", question: "Last answer?" },
    ];

    gw.worker.ask({
      ...source,
      requestId,
      kind: InteractionKind.QUESTION,
      toolName: "custom_question",
      requestJson: JSON.stringify({ questions: extended }),
    });

    const state = await eventually(
      () => snapshot(source.threadId),
      (s) => s.interactions.some((q) => q.requestId === requestId),
    );

    const interaction = state.interactions.find((q) => q.requestId === requestId)!;

    expect(mobileQuestions(interaction)).toHaveLength(6);
    await answerQuestions(
      client(),
      interaction,
      mobileQuestions(interaction).map((q) => ({ id: q.id, kind: "text", text: "Answered on mobile" })),
    );
    await answered(interaction, Array(6).fill("Answered on mobile"));
    gw.worker.finish(source.threadId, source.turnId);
  }, 20_000);

  test("paired phones allow, deny, grant a session and submit or decline MCP forms", async () => {
    const source = await start();

    for (const response of [
      { allow: true },
      { allow: false, message: "Denied by the user" },
      { allow: true, allowForSession: true },
    ]) {
      const requestId = Bun.randomUUIDv7();

      gw.worker.ask({
        ...source,
        requestId,
        kind: InteractionKind.PERMISSION,
        toolName: "shell",
        requestJson: JSON.stringify({ command: "git status", cwd: "/repo" }),
      });
      await eventually(
        () => snapshot(source.threadId),
        (s) => s.interactions.some((q) => q.requestId === requestId),
      );
      const result = await client().answerInteraction({ requestId, ...response });

      expect(result.interaction?.status).toBe(response.allow ? "allowed" : "declined");
      const delivered = await eventually(async () => gw.worker.interactionResponses.get(requestId), Boolean);

      expect(delivered).toMatchObject(response);
      expect((await snapshot(source.threadId)).interactions.some((q) => q.requestId === requestId)).toBe(false);
    }

    for (const response of [
      { answerJson: JSON.stringify({ name: "Mobile", count: 3, enabled: false }) },
      { cancelled: true },
    ]) {
      const requestId = Bun.randomUUIDv7();

      gw.worker.ask({
        ...source,
        requestId,
        kind: InteractionKind.ELICITATION,
        toolName: "mcp_form",
        requestJson: JSON.stringify({
          message: "Choose settings",
          requestedSchema: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" }, count: { type: "integer" }, enabled: { type: "boolean" } },
          },
        }),
      });
      await eventually(
        () => snapshot(source.threadId),
        (s) => s.interactions.some((q) => q.requestId === requestId),
      );
      const result = await client().answerInteraction({ requestId, ...response });

      expect(result.interaction?.status).toBe(response.cancelled ? "cancelled" : "answered");
      const delivered = await eventually(async () => gw.worker.interactionResponses.get(requestId), Boolean);

      expect(delivered).toMatchObject(response);
    }

    gw.worker.finish(source.threadId, source.turnId);
  }, 20_000);

  test("another owner's paired device cannot see or answer a request; revoked device cannot answer", async () => {
    const source = await start();
    const interaction = await ask("ask_user", source);
    const other = await pair();
    const ownerId = Bun.randomUUIDv7();
    await query(
      "INSERT INTO users(id,email,display_name,role) VALUES ($1,$2,'Other','user')",
      ownerId,
      `${ownerId}@example.test`,
    );
    await query("UPDATE mobile_devices SET owner_user_id=$1 WHERE id=$2", ownerId, other.device!.id);
    await expect(client(other.deviceToken).getThread({ threadId: source.threadId })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    await expect(answerQuestions(client(other.deviceToken), interaction, [], true)).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    const revoked = await pair();
    await gw.api.revokeMobileDevice({ id: revoked.device!.id });
    await expect(answerQuestions(client(revoked.deviceToken), interaction, [], true)).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    const foreignThread = Bun.randomUUIDv7();
    const foreignRequest = Bun.randomUUIDv7();
    await query(
      `INSERT INTO threads(id,root_thread_id,owner_user_id,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status)
       SELECT $1::uuid,$1::uuid,$2::uuid,project_id,'main',runtime,provider,worker_id,workspace_id,cwd,'idle'
       FROM threads WHERE id=$3::uuid`,
      foreignThread,
      ownerId,
      source.threadId,
    );
    await query(
      `INSERT INTO interaction_requests(id,thread_id,kind,tool_name,request,routed_to)
       SELECT $1::uuid,$2::uuid,kind,tool_name,request,'human' FROM interaction_requests WHERE id=$3::uuid`,
      foreignRequest,
      foreignThread,
      interaction.requestId,
    );
    await expect(
      answerQuestions(client(), { ...interaction, requestId: foreignRequest, threadId: foreignThread }, [], true),
    ).rejects.toMatchObject({ code: Code.NotFound });
    expect(await query("SELECT status FROM interaction_requests WHERE id=$1", foreignRequest)).toEqual([
      { status: "pending" },
    ]);

    expect((await snapshot(source.threadId)).interactions).toHaveLength(1);
    await answerQuestions(client(), interaction, [], true);
    gw.worker.finish(source.threadId, source.turnId);
  }, 20_000);

  test("a human-routed subagent question can be answered while viewing its parent", async () => {
    const parent = await start("Parent");

    const result = parseObject(
      (
        await gw.worker.callTool({
          ...parent,
          tool: "spawn_thread",
          args: { title: "Route reviewer", prompt: "Ask a question", interactions: "human", notify: false },
        })
      ).content,
    );

    const source = { threadId: str(result["thread_id"]), turnId: str(result["turn_id"]) };
    await eventually(
      () => snapshot(source.threadId),
      (s) => s.turns.some((t) => t.status === "running"),
    );
    const interaction = await ask("ask_user", source);
    expect(interaction.routedTo).toBe("human");
    expect(
      (await client().listThreads({ sidebarOnly: true })).threads.find((t) => t.id === source.threadId),
    ).toMatchObject({ parentThreadId: parent.threadId, title: "Route reviewer" });
    await answerQuestions(
      client(),
      interaction,
      mobileQuestions(interaction).map((q) => ({ id: q.id, kind: "skipped" })),
    );
    await answered(interaction, ["Skipped", "Skipped", "Skipped", "Skipped"]);
    gw.worker.finish(source.threadId, source.turnId);
    gw.worker.finish(parent.threadId, parent.turnId);
  }, 20_000);

  test("dismissal and expiry are enforced by the gateway", async () => {
    const source = await start();
    const dismissed = await ask("request_user_input", source);
    await answerQuestions(client(), dismissed, [], true);
    expect(await query("SELECT status FROM interaction_requests WHERE id=$1", dismissed.requestId)).toEqual([
      { status: "cancelled" },
    ]);
    const expiring = await ask("request_user_input", source);
    await query("UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE id=$1", expiring.requestId);
    await expect(answerQuestions(client(), expiring, [], true)).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(await query("SELECT status FROM interaction_requests WHERE id=$1", expiring.requestId)).toEqual([
      { status: "expired" },
    ]);
    gw.worker.finish(source.threadId, source.turnId);
  }, 20_000);

  test("a paired device answers all sources after a gateway restart with the worker's running turns", async () => {
    const sources = [];
    const interactions = [];

    for (const tool of ["AskUserQuestion", "request_user_input", "ask_user"]) {
      const source = await start();
      sources.push(source);
      interactions.push(await ask(tool, source));
    }

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    unmount();
    await network.close();
    await gw.close(true);
    // Reconnect the worker's declared live turns, as the same process does after a gateway outage.
    gw = await startTestGateway({
      storage,
      worker: { hello: { capabilities: ["running_turns"], runningTurns: sources } },
    });
    await mount();

    for (const interaction of interactions) {
      const recovered = (await snapshot(interaction.threadId)).interactions.find(
        (q) => q.requestId === interaction.requestId,
      )!;

      expect(recovered.status).toBe("pending");
      await answerQuestions(
        client(),
        recovered,
        mobileQuestions(recovered).map((q) => ({ id: q.id, kind: "text", text: "After restart" })),
      );
      await answered(recovered, Array(4).fill("After restart"));
    }

    for (const source of sources) gw.worker.finish(source.threadId, source.turnId);
  }, 60_000);
});
