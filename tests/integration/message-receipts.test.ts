import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { coreState } from "../../apps/gateway/src/core/core-context.ts";
import { startTestGateway, eventually, watchUntil, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("durable message admission receipts", () => {
  let gateway: TestGateway;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gateway = await startTestGateway();
    projectId = (await gateway.api.createProject({ name: "Receipts" })).project!.id;
    workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/receipts" })
    ).workspace!.id;
  });

  afterAll(async () => {
    await gateway?.close();
  });

  async function thread() {
    return (
      await gateway.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
  }

  async function snapshot(threadId: string) {
    const updates = await watchUntil(gateway.api, threadId, (list) => list.some((u) => u.change.case === "snapshot"));
    const update = updates.find((u) => u.change.case === "snapshot");

    if (update?.change.case !== "snapshot") throw new Error("Missing snapshot");

    return update.change.value;
  }

  test("concurrent retries retain one admission and replay its latest state after archival", async () => {
    const threadId = await thread();
    const request = { threadId, text: "One message", clientRequestId: crypto.randomUUID() };
    const results = await Promise.all(Array.from({ length: 8 }, () => gateway.api.sendMessage(request)));
    expect(new Set(results.map((r) => r.turn!.id)).size).toBe(1);

    const state = await eventually(
      () => snapshot(threadId),
      (s) => s.turns.some((t) => t.status === "completed"),
    );

    expect(state.turns).toHaveLength(1);
    await gateway.api.setThreadArchived({ threadId, archived: true });
    const replay = await gateway.api.sendMessage(request);
    expect(replay.turn?.id).toBe(results[0]!.turn!.id);
    expect(replay.turn?.status).toBe("completed");
  });

  test("a recreated core replays a platform command without another goal mutation and rejects another owner", async () => {
    const threadId = await thread();

    const request = create(ui.SendMessageRequestSchema, {
      threadId,
      text: "/goal One objective",
      mentions: [{ kind: MentionKind.COMMAND, name: "goal", source: "platform", start: 0, end: 5 }],
      clientRequestId: crypto.randomUUID(),
    });

    const original = await gateway.core.sendMessage(request);
    expect(original.goal).toBeDefined();
    const options = gateway.core[coreState].options;
    const recreated = new GatewayCore(options);
    const other = new GatewayCore({ ...options, userId: crypto.randomUUID() });

    try {
      await gateway.api.setGoal({ threadId, action: "set", objective: "New objective" });
      const replay = await recreated.sendMessage(request);
      expect(replay.goal?.id).toBe(original.goal!.id);
      expect((await snapshot(threadId)).goal?.objective).toBe("New objective");
      await expect(other.sendMessage(request)).rejects.toThrow("thread not found");
    } finally {
      await recreated.stopSweep();
      await other.stopSweep();
    }
  });
});
