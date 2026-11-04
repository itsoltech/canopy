import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, type GenerateText } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import {
  eventually,
  startTestGateway,
  watchUntil,
  type CommandReplyExtra,
  type TestGateway,
} from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread titles through the worker link", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";
  const requests: GenerateText[] = [];
  let answer: ((ok: boolean, extra?: CommandReplyExtra) => void) | undefined;
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Titles" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo", label: "repo" }))
      .workspace!.id;
    await eventually(
      () => gw.api.getOverview({}),
      (r) => r.workers.some((w) => w.id === gw.workerId && w.providerInstances.some((i) => i.available)),
    );
    gw.worker.handlers.set("generateText", (value, reply) => {
      requests.push(value as GenerateText);
      answer = reply;
    });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  const createThread = async (message = "", title = "") =>
    (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, initialMessage: message, title }))
      .thread!;

  const current = (id: string) => gw.api.getThread({ threadId: id }).then((r) => r.thread!);

  const requested = async (count: number) =>
    expect(
      await eventually(
        async () => requests.length,
        (n) => n === count,
      ),
    ).toBe(count);

  test("first message titles asynchronously and broadcasts without creating extra turns", async () => {
    const thread = await createThread();
    const count = requests.length;

    const sent = await gw.api.sendMessage({
      threadId: thread.id,
      text: "/goal napisać siema",
      clientRequestId: "first",
    });

    await requested(count + 1);
    expect((await current(thread.id)).titleSource).toBe("provisional");
    expect(requests.at(-1)?.prompt).toContain("napisać siema");
    expect(requests.at(-1)?.prompt).not.toContain('"/goal napisać');
    // The ordinary turn completes even while generation is held.
    await watchUntil(gw.api, thread.id, (updates) =>
      updates.some(
        (u) =>
          (u.change.case === "snapshot" &&
            u.change.value.turns.some((t) => t.id === sent.turn?.id && t.status === "completed")) ||
          (u.change.case === "turn" && u.change.value.id === sent.turn?.id && u.change.value.status === "completed"),
      ),
    );
    answer?.(true, { generatedText: '"Powitanie po polsku."' });
    await watchUntil(gw.api, thread.id, (updates) =>
      updates.some(
        (u) =>
          (u.change.case === "thread" && u.change.value.title === "Powitanie po polsku") ||
          (u.change.case === "snapshot" && u.change.value.thread?.title === "Powitanie po polsku"),
      ),
    );
    expect((await current(thread.id)).titleSource).toBe("generated");
    await gw.api.sendMessage({ threadId: thread.id, text: "second", clientRequestId: "second" });
    expect(requests.length).toBe(count + 1);
  });

  test("rename wins over an in-flight title; explicit titles are never automatically replaced", async () => {
    const count = requests.length;
    const thread = await createThread("Fix login");
    await requested(count + 1);
    await gw.api.updateThread({ threadId: thread.id, title: "My title" });
    answer?.(true, { generatedText: "Stale result" });
    await createThread("Do work", "Explicit title");
    const renamed = await current(thread.id);
    expect([renamed.title, renamed.titleSource]).toEqual(["My title", "user"]);
    expect(requests.length).toBe(count + 1);
  });

  test("regenerate uses the global instance/model/effort and appended instructions, failures retain the title", async () => {
    const thread = await createThread("Fix login", "Explicit");
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({
      expectedVersion: settings.version,
      textGeneration: {
        provider: Provider.CODEX,
        profileId: "native",
        model: "gpt-5.5",
        effort: "low",
        threadTitleInstructions: "Use three words",
      },
    });
    let count = requests.length;
    await gw.api.regenerateTitle({ threadId: thread.id });
    await requested(count + 1);
    expect(requests.at(-1)).toMatchObject({ model: "gpt-5.5", effort: "low", profileId: "native" });
    expect(requests.at(-1)?.prompt).toEndWith("Use three words");
    // While the worker generates, the thread says so (the UI shows it on the title).
    expect((await current(thread.id)).titleGenerating).toBe(true);
    answer?.(true, { generatedText: "Better login flow" });

    const done = await eventually(
      () => current(thread.id),
      (t) => t.titleSource === "generated" && !t.titleGenerating,
    );

    expect(done.title).toBe("Better login flow");
    count = requests.length;
    const failed = await createThread("Provisional on failure");
    await requested(count + 1);
    answer?.(false, { errorCode: "TEXT_GENERATION_FAILED" });

    const kept = await eventually(
      () => current(failed.id),
      (t) => !t.titleGenerating,
    );

    expect([kept.title, kept.titleSource]).toEqual(["Provisional on failure", "provisional"]);
    await gw.api.sendMessage({ threadId: failed.id, text: "No retry storm", clientRequestId: "second" });
    expect(requests.length).toBe(count + 1);
  });

  test("regeneration uses inherited fork input and an explicit thread's goal without a user turn", async () => {
    const source = await createThread("Fix the inherited login task", "Source");

    const history = await watchUntil(gw.api, source.id, (updates) =>
      updates.some(
        (u) =>
          (u.change.case === "snapshot" && u.change.value.turns.some((t) => t.status === "completed")) ||
          (u.change.case === "turn" && u.change.value.status === "completed"),
      ),
    );

    const turn = (await gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(source.id)))).find(
      (t) => t.status === "completed",
    )!;

    expect(history.length).toBeGreaterThan(0);
    const fork = (await gw.api.createThread({ forkThreadId: source.id, forkAtTurnId: turn.id })).thread!;
    let count = requests.length;
    await gw.api.regenerateTitle({ threadId: fork.id });
    await requested(count + 1);
    expect(requests.at(-1)?.prompt).toContain("Fix the inherited login task");
    answer?.(true, { generatedText: "Inherited login task" });
    await eventually(
      () => current(fork.id),
      (t) => t.titleSource === "generated",
    );

    const goalThread = await createThread("", "Explicit goal thread");
    await gw.api.setGoal({ threadId: goalThread.id, action: "set", objective: "Improve goal scheduling" });
    count = requests.length;
    await gw.api.regenerateTitle({ threadId: goalThread.id });
    await requested(count + 1);
    expect(requests.at(-1)?.prompt).toContain("Improve goal scheduling");
    answer?.(true, { generatedText: "Goal scheduling" });
    await eventually(
      () => current(goalThread.id),
      (t) => t.titleSource === "generated",
    );
  });

  test("an unavailable generation instance preserves the provisional title and does not queue retries", async () => {
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({
      expectedVersion: settings.version,
      textGeneration: { provider: Provider.CODEX, profileId: "offline-instance", model: "gpt-5.5", effort: "low" },
    });
    const count = requests.length;
    const thread = await createThread("Keep this provisional title");
    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((s) => s.thread(thread.id))),
      (t) => t.title_requested,
    );
    await watchUntil(gw.api, thread.id, (updates) =>
      updates.some(
        (u) =>
          (u.change.case === "snapshot" && u.change.value.turns.some((t) => t.status === "completed")) ||
          (u.change.case === "turn" && u.change.value.status === "completed"),
      ),
    );
    expect(await current(thread.id)).toMatchObject({
      title: "Keep this provisional title",
      titleSource: "provisional",
    });

    const sent = await gw.api.sendMessage({
      threadId: thread.id,
      text: "Still no title retry",
      clientRequestId: "offline-second",
    });

    await watchUntil(gw.api, thread.id, (updates) =>
      updates.some(
        (u) =>
          (u.change.case === "snapshot" &&
            u.change.value.turns.some((t) => t.id === sent.turn?.id && t.status === "completed")) ||
          (u.change.case === "turn" && u.change.value.id === sent.turn?.id && u.change.value.status === "completed"),
      ),
    );
    expect(requests.length).toBe(count);
    const queued = await gw.runtime.runPromise(GatewayStore.use((s) => s.pendingCommands(gw.workerId)));
    expect(queued.some((c) => c.kind.case === "generateText")).toBe(false);
  });
});
