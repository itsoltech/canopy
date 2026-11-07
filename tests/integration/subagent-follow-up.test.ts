import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, TurnOutcome, ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { dockerAvailable } from "@canopy/db/testing";
import { AgentBusStore, GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { eventually, failure, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let parentId = "";

async function snapshot(threadId: string) {
  const updates = await watchUntil(gw.api, threadId, (list) => list.some((u) => u.change.case === "snapshot"));
  const snapshots = updates.flatMap((u) => (u.change.case === "snapshot" ? [u.change.value] : []));

  return snapshots[0]!;
}

describe.skipIf(!dockerAvailable)("owner follow-ups to finished subagents", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    const project = (await gw.api.createProject({ name: "Follow-ups" })).project!;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo/app" })
    ).workspace!;

    parentId = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        title: "Parent",
      })
    ).thread!.id;
    await eventually(
      () => gw.api.getThread({ threadId: parentId }),
      (r) => r.thread?.status === "idle",
    );
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  for (const [status, outcome] of [
    ["completed", TurnOutcome.COMPLETED],
    ["failed", TurnOutcome.FAILED],
    ["interrupted", TurnOutcome.INTERRUPTED],
  ] as const) {
    test(`${status}: history and owner follow-up stay on the subagent's worker and provider session`, async () => {
      gw.worker.holdTurns = true;
      const title = `Subagent ${status}`;

      const spawned = await gw.worker.callTool({
        threadId: parentId,
        tool: "spawn_thread",
        args: { title, prompt: "Inspect the change", notify: false },
      });

      expect(spawned.isError).toBe(false);

      const thread = await eventually(
        async () => (await gw.api.listThreads({})).threads.find((t) => t.title === title),
        (t) => t?.status === "running",
      );

      const first = await snapshot(thread!.id);
      const turn = first.turns[0]!;
      gw.worker.finish(thread!.id, turn.id, "Inspection history");
      // Use a fresh held turn for failure/interruption, leaving earlier history readable.
      await eventually(
        () => snapshot(thread!.id),
        (s) => s.turns[0]?.status === "completed",
      );

      if (outcome !== TurnOutcome.COMPLETED) {
        const next = (
          await gw.api.sendMessage({
            threadId: thread!.id,
            text: "Continue inspecting",
            clientRequestId: Bun.randomUUIDv7(),
          })
        ).turn!;

        await eventually(async () => gw.worker.started.has(next.id), Boolean);
        gw.worker.emit(thread!.id, next.id, { case: "turnFinished", value: { outcome } });
      }

      await eventually(
        () => gw.api.getThread({ threadId: thread!.id }),
        (r) => r.thread?.lastTurnStatus === status,
      );
      const before = await snapshot(thread!.id);
      expect(
        before.items.some(
          (entry) =>
            entry.item?.content.case === "agentMessage" && entry.item.content.value.text === "Inspection history",
        ),
      ).toBe(true);

      gw.worker.holdTurns = false;

      const response = await gw.api.sendMessage({
        threadId: thread!.id,
        text: "Also check this small detail",
        clientRequestId: Bun.randomUUIDv7(),
      });

      const after = await eventually(
        () => snapshot(thread!.id),
        (s) => s.turns.some((t) => t.id === response.turn?.id && t.status === "completed"),
      );

      expect(after.turns).toHaveLength(before.turns.length + 1);
      expect(after.thread).toMatchObject({ parentThreadId: parentId, spawnedByAgent: true, workerId: gw.workerId });
      const command = gw.worker.commands.find((c) => c.case === "startTurn" && c.value.turnId === response.turn?.id);
      expect(command?.case === "startTurn" && command.value.thread).toMatchObject({
        threadId: thread!.id,
        providerThreadId: `codex-${thread!.id}`,
      });
      expect(gw.worker.started.get(response.turn!.id)?.authorUserId).toBe(gw.userId);
    });
  }

  test("another owner's subagent remains unreadable and cannot receive a user follow-up", async () => {
    const other = await gw.runtime.runPromise(
      GatewayStore.use((store) =>
        Effect.gen(function* () {
          const owner = yield* store.ensureUser("other@localhost", "Other");
          const project = yield* store.createProject(owner, "Private");
          const worker = yield* store.addWorker({ ownerUserId: owner, name: "Private worker" });

          const workspace = yield* store.createWorkspace({
            projectId: project.id,
            workerId: worker.workerId,
            rootPath: "/repo/private",
            label: "",
          });

          const parent = yield* store.createThread(
            owner,
            create(ui.CreateThreadRequestSchema, {
              projectId: project.id,
              workspaceId: workspace.id,
              provider: Provider.CODEX,
              title: "Private parent",
            }),
          );

          const caller = yield* store.thread(parent.id);

          const child = yield* AgentBusStore.use((bus) =>
            bus.spawn({
              source: { callId: Bun.randomUUIDv7(), threadId: parent.id, turnId: "", itemId: "" },
              caller,
              args: { title: "Private subagent", prompt: "Inspect privately", notify: false },
              target: { harness: "codex", instance: "native", model: "", effort: "" },
              hops: 1,
            }),
          );

          return child.thread;
        }),
      ),
    );

    expect(await failure(gw.api.getThread({ threadId: other.id }))).toContain("not found");
    expect(
      await failure(gw.api.sendMessage({ threadId: other.id, text: "Follow up", clientRequestId: Bun.randomUUIDv7() })),
    ).toContain("not found");
    expect(gw.worker.created.some((thread) => thread.threadId === other.id)).toBe(false);
  });
});
