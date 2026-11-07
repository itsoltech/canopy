import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Provider, ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { GatewayCore } from "@canopy/gateway/core";
import { dockerAvailable } from "@canopy/db/testing";
import { SHELL_INPUT_OUTPUT_BYTES, shellInputText } from "@canopy/domain";
import { waitForProcessStopped } from "@canopy/testing";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";
import { eventually, failure, watchUntil } from "./support/gateway.ts";

let fixture: InstanceFixture;

const snapshot = async (id: string) => {
  const updates = await watchUntil(fixture.gw.api, id, (u) => u.length > 0);
  const first = updates[0]!;

  if (first.change.case !== "snapshot") throw new Error("Missing snapshot");

  return first.change.value;
};

describe.skipIf(!dockerAvailable)("composer shell input over gRPC and scripted harnesses", () => {
  beforeAll(async () => {
    fixture = await startInstanceFixture();

    for (const provider of [Provider.CODEX, Provider.CLAUDE, Provider.GROK]) await fixture.save(provider, "shell");
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  test("idle shell commands reach every harness as the persisted result, including failures and stdin EOF", async () => {
    for (const provider of [Provider.CODEX, Provider.CLAUDE, Provider.GROK]) {
      const thread = await fixture.thread(provider);
      const command = "printf 'shell output\\n'; printf 'shell error\\n' >&2; cat; exit 7";
      const turn = await fixture.send(thread.id, `!${command}`);
      const done = await fixture.finished(thread.id, turn.id);
      expect(done.status).toBe("completed");
      expect(done.shellResult).toMatchObject({
        command,
        cwd: join(fixture.dir, "repo"),
        status: "completed",
        exitCode: 7,
      });
      expect(done.shellResult?.output).toContain("shell output\n");
      expect(done.shellResult?.output).toContain("shell error\n");
      expect(done.inputText).toBe(shellInputText(done.shellResult!));
      const view = await snapshot(thread.id);
      expect(
        view.items.some((i) => i.item?.content.case === "agentMessage" && i.item.content.value.text === done.inputText),
      ).toBe(true);
      expect(view.turns[0]?.inputText).toBe(done.inputText);
    }
  }, 30_000);

  test("queued commands execute only at dequeue, in order; an edited message retains shell semantics", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const first = await fixture.send(thread.id, "HOLD:shell-queue");
    await eventually(
      async () => fixture.host.runningTurns(),
      (t) => t.some((t) => t.turnId === first.id),
    );
    const marker = join(fixture.dir, "queue-order");
    const queued = await fixture.send(thread.id, `!printf wrong >> '${marker}'`);
    await fixture.gw.api.editQueuedTurn({
      turnId: queued.id,
      expectedRevision: queued.revision,
      text: `!printf first >> '${marker}'; cat '${marker}'`,
    });
    const last = await fixture.send(thread.id, `!printf second >> '${marker}'; cat '${marker}'`);
    expect(existsSync(marker)).toBe(false);
    await fixture.release("shell-queue");
    expect((await fixture.finished(thread.id, queued.id)).shellResult?.output).toBe("first");
    expect((await fixture.finished(thread.id, last.id)).shellResult?.output).toBe("firstsecond");
  }, 15_000);

  test("Codex steer executes at delivery and uses the existing turn/steer input path", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const first = await fixture.send(thread.id, "HOLD:shell-steer");
    await eventually(
      async () => fixture.records(),
      (r) => r.some((r) => r.event === "turn" && r.session === thread.providerThreadId),
    );

    const sent = await fixture.gw.api.sendMessage({
      threadId: thread.id,
      text: "!printf steered",
      clientRequestId: crypto.randomUUID(),
      delivery: ui.MessageDelivery.STEER,
    });

    const echoed = (s: ui.ThreadSnapshot, steer: ui.Steer) =>
      s.items.some(
        (i) =>
          i.item?.content.case === "userMessage" &&
          i.item.content.value.clientId === steer.id &&
          i.item.content.value.text === steer.inputText,
      );

    // A watch snapshot reads items before steers, so it can show the steer delivered without its item yet.
    const view = await eventually(
      () => snapshot(thread.id),
      (s) => s.steers.some((steer) => steer.id === sent.steer?.id && steer.status === "delivered" && echoed(s, steer)),
    );

    const steer = view.steers.find((s) => s.id === sent.steer?.id)!;
    expect(steer.shellResult?.output).toBe("steered");
    expect(echoed(view, steer)).toBe(true);
    await fixture.release("shell-steer");
    await fixture.finished(thread.id, first.id);
  }, 15_000);

  test("a Grok steer stays queued and executes only after its current turn", async () => {
    const thread = await fixture.thread(Provider.GROK);
    const first = await fixture.send(thread.id, "HOLD:shell-grok");
    await eventually(
      async () => fixture.records(),
      (r) => r.some((r) => r.event === "turn" && r.session === thread.providerThreadId),
    );
    const marker = join(fixture.dir, "grok-shell");
    await fixture.gw.api.sendMessage({
      threadId: thread.id,
      text: `!printf grok > '${marker}'; cat '${marker}'`,
      clientRequestId: crypto.randomUUID(),
      delivery: ui.MessageDelivery.STEER,
    });

    const view = await eventually(
      () => snapshot(thread.id),
      (s) => s.steers.some((s) => s.status === "queued"),
    );

    expect(existsSync(marker)).toBe(false);
    await fixture.release("shell-grok");
    await fixture.finished(thread.id, first.id);
    expect((await fixture.finished(thread.id, view.steers[0]!.queuedTurnId)).shellResult?.output).toBe("grok");
  }, 15_000);

  test("Claude steer receives the prepared result through its existing input stream", async () => {
    const thread = await fixture.thread(Provider.CLAUDE);
    const first = await fixture.send(thread.id, "HOLD:shell-claude");
    await eventually(
      async () => fixture.records(),
      (r) => r.some((r) => r.event === "turn" && r.session === thread.providerThreadId),
    );

    const sent = await fixture.gw.api.sendMessage({
      threadId: thread.id,
      text: "!printf claude-steer",
      clientRequestId: crypto.randomUUID(),
      delivery: ui.MessageDelivery.STEER,
    });

    const view = await eventually(
      () => snapshot(thread.id),
      (s) =>
        s.items.some(
          (i) => i.item?.content.case === "agentMessage" && i.item.content.value.text.includes("claude-steer"),
        ),
    );

    const steer = view.steers.find((s) => s.id === sent.steer?.id)!;
    expect(steer.shellResult?.output).toBe("claude-steer");
    expect(
      view.items.some((i) => i.item?.content.case === "agentMessage" && i.item.content.value.text === steer.inputText),
    ).toBe(true);
    await fixture.release("shell-claude");
    await fixture.finished(thread.id, first.id);
  }, 15_000);

  test("a turn ending during a shell steer queues its result without repeating the command", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const first = await fixture.send(thread.id, "HOLD:shell-late");
    await eventually(
      async () => fixture.records(),
      (r) => r.some((r) => r.event === "turn" && r.session === thread.providerThreadId),
    );
    const marker = join(fixture.dir, "late-steer");

    const sent = await fixture.gw.api.sendMessage({
      threadId: thread.id,
      text: `!printf once >> '${marker}'; sleep 0.3; printf late-result`,
      clientRequestId: crypto.randomUUID(),
      delivery: ui.MessageDelivery.STEER,
    });

    await eventually(async () => existsSync(marker), Boolean);
    await fixture.release("shell-late");
    await fixture.finished(thread.id, first.id);

    const view = await eventually(
      () => snapshot(thread.id),
      (s) => s.steers.some((s) => s.id === sent.steer?.id && Boolean(s.queuedTurnId)),
    );

    const fallback = view.steers.find((s) => s.id === sent.steer?.id)!.queuedTurnId;
    expect((await fixture.finished(thread.id, fallback)).shellResult?.output).toBe("late-result");
    expect(readFileSync(marker, "utf8")).toBe("once");
  }, 15_000);

  test("initial and side-thread shell inputs run in their chosen directory; whitespace keeps ordinary text", async () => {
    const parent = await fixture.thread(Provider.CODEX);

    for (const side of [false, true]) {
      const created = (
        await fixture.gw.api.createThread({
          projectId: parent.projectId,
          workspaceId: parent.workspaceId,
          provider: parent.provider,
          providerProfileId: parent.providerProfileId,
          parentThreadId: side ? parent.id : "",
          initialMessage: "!pwd",
          clientRequestId: crypto.randomUUID(),
        })
      ).thread!;

      const view = await eventually(
        () => snapshot(created.id),
        (s) => s.turns[0]?.status === "completed",
      );

      expect(view.turns[0]?.shellResult?.cwd).toBe(join(fixture.dir, "repo"));
      expect(view.turns[0]?.shellResult?.output.trim()).toBe(join(fixture.dir, "repo"));
    }

    const ordinary = await fixture.send(parent.id, " !printf ordinary");
    expect((await fixture.finished(parent.id, ordinary.id)).shellCommand).toBeUndefined();
  }, 15_000);

  test("a disconnected gateway link replays results without repeating shell effects", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const marker = join(fixture.dir, "reconnect-shell");
    const turn = await fixture.send(thread.id, `!printf once >> '${marker}'; sleep 0.2; printf reconnect-result`);
    await eventually(async () => existsSync(marker), Boolean);
    await fixture.disconnect();
    await fixture.reconnect();
    expect((await fixture.finished(thread.id, turn.id)).shellResult?.output).toBe("reconnect-result");
    expect(readFileSync(marker, "utf8")).toBe("once");
  }, 15_000);

  test("output capture keeps bounded head and tail with a marked omission", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const turn = await fixture.send(thread.id, "!printf HEAD; yes x | head -c 100000; printf TAIL");
    const result = (await fixture.finished(thread.id, turn.id)).shellResult!;
    expect(result.truncated).toBe(true);
    expect(result.output.startsWith("HEAD")).toBe(true);
    expect(result.output.endsWith("TAIL")).toBe(true);
    expect(result.output).toContain("output bytes omitted");
    expect(Buffer.byteLength(result.output)).toBeLessThan(SHELL_INPUT_OUTPUT_BYTES + 100);
  }, 10_000);

  test("a gateway restart during execution keeps the same shell run and result", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const marker = join(fixture.dir, "gateway-restart-count");
    const release = join(fixture.dir, "release-shell-gateway");

    const turn = await fixture.send(
      thread.id,
      `!printf once >> '${marker}'; while ! test -f '${release}'; do sleep 0.01; done; printf gateway-restarted`,
    );

    await eventually(async () => existsSync(marker), Boolean);
    await fixture.restartGateway();
    await fixture.reconnect();
    expect((await snapshot(thread.id)).turns[0]?.status).toBe("running");
    await fixture.release("shell-gateway");
    expect((await fixture.finished(thread.id, turn.id)).shellResult?.output).toBe("gateway-restarted");
    expect(readFileSync(marker, "utf8")).toBe("once");
  }, 15_000);

  test("timeout and Stop kill the process group and settle the turn without starting a harness", async () => {
    for (const stop of [false, true]) {
      // Only the timeout case gets a short deadline. Stop must exercise cancellation, even on busy CI.
      const current = stop ? fixture : await startInstanceFixture(false, {}, { shellTimeoutMs: 1_500 });

      try {
        if (!stop) await current.save(Provider.CODEX, "shell-timeout");
        const thread = await current.thread(Provider.CODEX);
        const marker = join(current.dir, `shell-pid-${thread.id}`);

        const turn = await current.send(
          thread.id,
          `!sleep 60 & child=$!; printf '%s' "$child" > '${marker}.tmp'; mv '${marker}.tmp' '${marker}'; wait`,
        );

        expect(await eventually(async () => existsSync(marker), Boolean)).toBe(true);
        const pid = Number(readFileSync(marker, "utf8"));

        if (stop) {
          // The local PID can be published before the gateway applies turnStarted. Stop targets a running turn.
          await watchUntil(current.gw.api, thread.id, (updates) =>
            updates.some((u) =>
              u.change.case === "snapshot"
                ? u.change.value.turns.some((t) => t.id === turn.id && t.status === "running")
                : u.change.case === "turn" && u.change.value.id === turn.id && u.change.value.status === "running",
            ),
          );
          await current.gw.api.interruptThread({ threadId: thread.id });
        }

        const done = await current.finished(thread.id, turn.id);
        expect(done.status).toBe(stop ? "interrupted" : "failed");
        expect(done.shellResult?.status).toBe(stop ? "interrupted" : "failed");

        if (stop) expect(done.interruptSource).toBe("user");
        await waitForProcessStopped(pid);
        expect(current.records().some((r) => r.event === "turn" && r.session === thread.providerThreadId)).toBe(false);
      } finally {
        if (!stop) await current.close();
      }
    }
  }, 15_000);

  test("worker restart interrupts the command durably, never repeats its side effects, and drains the queue", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const marker = join(fixture.dir, "restart-count");
    const first = await fixture.send(thread.id, `!printf once >> '${marker}'; sleep 60`);
    const next = await fixture.send(thread.id, "!printf after-restart");
    await eventually(async () => existsSync(marker), Boolean);
    await fixture.restartWorker();
    const interrupted = await fixture.finished(thread.id, first.id);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.shellResult?.status).toBe("interrupted");
    expect(interrupted.interruptSource).toBe("system");
    expect((await fixture.finished(thread.id, next.id)).shellResult?.output).toBe("after-restart");
    expect(readFileSync(marker, "utf8")).toBe("once");
  }, 20_000);

  test("a shell terminated by a signal ends clearly without starting the agent", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const turn = await fixture.send(thread.id, "!kill -TERM $$");
    const done = await fixture.finished(thread.id, turn.id);
    expect(done.shellResult?.status).toBe("failed");
    expect(done.shellResult?.reason).toContain("without an exit code");
    expect(fixture.records().some((r) => r.event === "turn" && r.session === thread.providerThreadId)).toBe(false);
  }, 10_000);

  test("Stop during a shell steer kills its group and persists the failed delivery", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const first = await fixture.send(thread.id, "HOLD:shell-stop-steer");
    await eventually(
      async () => fixture.records(),
      (r) => r.some((r) => r.event === "turn" && r.session === thread.providerThreadId),
    );
    const marker = join(fixture.dir, "steer-child");

    const sent = await fixture.gw.api.sendMessage({
      threadId: thread.id,
      text: `!sleep 60 & child=$!; printf '%s' "$child" > '${marker}.tmp'; mv '${marker}.tmp' '${marker}'; wait`,
      clientRequestId: crypto.randomUUID(),
      delivery: ui.MessageDelivery.STEER,
    });

    await eventually(async () => existsSync(marker), Boolean);
    const pid = Number(readFileSync(marker, "utf8"));
    await fixture.gw.api.interruptThread({ threadId: thread.id });
    await fixture.finished(thread.id, first.id);

    const view = await eventually(
      () => snapshot(thread.id),
      (s) => s.steers.some((s) => s.id === sent.steer?.id && s.status === "failed"),
    );

    expect(view.steers.find((s) => s.id === sent.steer?.id)?.shellResult?.status).toBe("interrupted");
    await waitForProcessStopped(pid);
    await fixture.release("shell-stop-steer");
  }, 15_000);

  test("internal thread creation used by bots and agents keeps a leading bang as ordinary input", async () => {
    const parent = await fixture.thread(Provider.CODEX);
    const marker = join(fixture.dir, "internal-not-shell");

    const thread = await fixture.gw.core.createThread(
      create(ui.CreateThreadRequestSchema, {
        projectId: parent.projectId,
        workspaceId: parent.workspaceId,
        provider: parent.provider,
        initialMessage: `!touch '${marker}'`,
        clientRequestId: crypto.randomUUID(),
      }),
    );

    const view = await eventually(
      () => snapshot(thread.id),
      (s) => s.turns[0]?.status === "completed",
    );

    expect(view.turns[0]?.shellCommand).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  test("an owner cannot execute commands in another owner's thread", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const other = Bun.randomUUIDv7();
    await fixture.query(
      "INSERT INTO users (id, email, role, display_name) VALUES ($1, 'shell-other@example.test', 'user', 'Other owner')",
      [other],
    );
    const foreign = new GatewayCore({ runtime: fixture.gw.runtime, userId: other, instanceId: "shell-foreign" });
    const marker = join(fixture.dir, "not-owner");
    expect(
      await failure(
        foreign.sendMessage(
          create(ui.SendMessageRequestSchema, {
            threadId: thread.id,
            text: `!touch '${marker}'`,
            clientRequestId: crypto.randomUUID(),
          }),
        ),
      ),
    ).toContain("thread not found");
    expect(existsSync(marker)).toBe(false);
    await foreign.stopSweep();
  }, 10_000);
});

describe.skipIf(!dockerAvailable)("shell capability negotiation", () => {
  test("an older worker rejects shell input with an actionable error and never sees raw text", async () => {
    const legacy = await startInstanceFixture(false, {}, {}, false);

    try {
      await legacy.save(Provider.CODEX, "legacy-shell");
      const thread = await legacy.thread(Provider.CODEX);
      const turn = await legacy.send(thread.id, "!printf never-run");
      const failed = await legacy.finished(thread.id, turn.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("Update the worker");
      expect(legacy.records().some((r) => r.event === "turn" && r.session === thread.providerThreadId)).toBe(false);
    } finally {
      await legacy.close();
    }
  }, 60_000);
});
