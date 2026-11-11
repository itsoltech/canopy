import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ManagedRuntime } from "effect";
import { tempDir } from "@canopy/testing";
import {
  ItemDeltaField,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  UserInputSchema,
  TurnOutcome,
  ui,
} from "@canopy/contracts";
import { Journal } from "@canopy/worker/journal";
import { applyAck, journalHello, resendPending } from "@canopy/worker/gateway-link";
import { WorkerDiagnostics, workerDiagnostics } from "../../apps/worker/src/diagnostics/worker.ts";
import { GrokThreads } from "../../apps/worker/src/providers/grok/threads.ts";
import { freshGit, git } from "../../apps/worker/src/git/git.ts";
import { harnessMetric, gitMetric } from "@canopy/domain/diagnostics";
import { connectWorker, startGateway, take } from "./helpers.ts";

const directory = tempDir("canopy-worker-diagnostics-");

describe("worker instrumentation preserves durable delivery and private harness data", () => {
  test("journal counters survive ACK, reconnect pruning and restart without changing sequence", async () => {
    const path = join(directory, "journal.db");
    let runtime = ManagedRuntime.make(Journal.layer(path, true));
    const gateway = await startGateway();
    workerDiagnostics.enabled = true;

    try {
      const journal = await runtime.runPromise(Journal);
      const id = journal.journalId;

      const first = await runtime.runPromise(
        journal.append("t", {
          body: { case: "itemDelta", value: { itemId: "a", field: ItemDeltaField.TEXT, chunk: "private-prompt" } },
        }),
      );

      const second = await runtime.runPromise(
        journal.append("t", { body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } } }),
      );

      expect(journal.statistics!().events).toBe(2);
      expect(journal.statistics!().bytes).toBeGreaterThan(0);
      expect(journal.statistics!().oldest).toBeGreaterThan(0);

      let link = await connectWorker(gateway.server.url, {
        hello: { workerId: "worker-1", ...(await runtime.runPromise(journalHello())) },
      });

      let connection = await gateway.nextConnection();
      await runtime.runPromise(resendPending(link));
      expect((await take(connection.messages, 2)).map((row) => row.payload.case)).toEqual([
        "threadEvent",
        "threadEvent",
      ]);
      connection.send({ case: "eventAck", value: { threadId: "t", ackSeq: first.journalSeq } });
      const [ack] = await take(link.messages, 1);

      if (ack?.payload.case !== "eventAck") throw new Error("Missing ACK");
      expect(await runtime.runPromise(applyAck(ack.payload.value))).toBe(1);
      expect(journal.statistics!().events).toBe(1);
      link.close();
      await connection.closed;
      await runtime.dispose();
      runtime = ManagedRuntime.make(Journal.layer(path, true));
      const restored = await runtime.runPromise(Journal);
      expect(restored.journalId).toBe(id);
      expect(restored.statistics!().events).toBe(1);
      link = await connectWorker(gateway.server.url, {
        hello: { workerId: "worker-1", ...(await runtime.runPromise(journalHello())) },
      });
      connection = await gateway.nextConnection();
      await runtime.runPromise(resendPending(link));
      const [replay] = await take(connection.messages, 1);
      expect(replay?.payload.case === "threadEvent" && replay.payload.value.eventId).toBe(second.eventId);
      await runtime.runPromise(restored.pending(new Map([["t", second.journalSeq]])));
      expect(restored.statistics!()).toEqual({ events: 0, bytes: 0, oldest: 0 });
      const next = await runtime.runPromise(restored.append("t", {}));
      expect(next.journalSeq).toBe(second.journalSeq + 1n);
      const values = workerDiagnostics.measurements.drain(Date.now());
      expect(values.find((row) => row.metricId === 103)?.events).toBe(3n);
      expect(values.find((row) => row.metricId === 104)?.events).toBe(1n);
      expect(
        toJsonString(ui.WorkerLinkDiagnosticsSchema, create(ui.WorkerLinkDiagnosticsSchema, { measures: values })),
      ).not.toContain("private-prompt");
      link.close();
      await connection.closed;
    } finally {
      workerDiagnostics.stop();
      await runtime.dispose();
      await gateway.link.shutdown();
      await gateway.server.close();
    }
  });

  test("deterministic ACP reports text TTFT, terminal outcomes and no-text failures without prompts or paths", async () => {
    const runtime = ManagedRuntime.make(Journal.layer(join(directory, "harness.db"), true));
    workerDiagnostics.enabled = true;

    const threads = new GrokThreads({
      dataDir: directory,
      executable: resolve(import.meta.dir, "../../apps/worker/src/providers/grok/fixtures/agent.ts"),
      linkDeviceLogin: false,
      profile: () => ({ kind: "native", id: "native", providers: ["grok"], env: {}, runtime: { ownLogin: true } }),
      record: (thread, event) => runtime.runPromise(Journal.use((journal) => journal.append(thread, event))),
      interact: async () => {
        throw new Error("Unexpected interaction");
      },
      callTool: async () => {
        throw new Error("Unexpected tool");
      },
    });

    const spec = create(ThreadSpecSchema, {
      threadId: "harness-thread",
      cwd: directory,
      provider: Provider.GROK,
      providerProfileId: "native",
      model: "fake-grok",
      permissionMode: PermissionMode.FULL_ACCESS,
    });

    try {
      await threads.startTurn(spec, "success", create(UserInputSchema, { text: "private-prompt SANDBOX" }));
      await threads.startTurn(spec, "failure", create(UserInputSchema, { text: "private-prompt FAIL_AUTH" }));
      const values = workerDiagnostics.measurements.drain(Date.now());
      expect(values.find((row) => row.metricId === harnessMetric("grok", "ttft"))?.events).toBe(1n);
      expect(values.find((row) => row.metricId === harnessMetric("grok", "turn"))?.events).toBe(2n);
      expect(values.find((row) => row.metricId === harnessMetric("grok", "completed"))?.events).toBe(1n);
      expect(values.find((row) => row.metricId === harnessMetric("grok", "failed"))?.events).toBe(1n);

      const json = toJsonString(
        ui.WorkerLinkDiagnosticsSchema,
        create(ui.WorkerLinkDiagnosticsSchema, { measures: values }),
      );

      for (const secret of [directory, "private-prompt", "fixture-leak", "login expired"])
        expect(json).not.toContain(secret);
      expect(workerDiagnostics.turns.active.size).toBe(0);
    } finally {
      await threads.close();
      workerDiagnostics.stop();
      await runtime.dispose();
    }
  });

  test("git records an allowlisted family for successful and failed subprocesses without argv or cwd", async () => {
    workerDiagnostics.enabled = true;

    try {
      await freshGit(() => git(directory, ["rev-parse", "--is-inside-work-tree"]));
      await git(directory, ["status", "--private-invalid-option"]);
      const values = workerDiagnostics.measurements.drain(Date.now());
      expect(values.find((row) => row.metricId === gitMetric("refs", "execution"))?.events).toBe(1n);
      expect(values.find((row) => row.metricId === gitMetric("status", "execution"))?.errors).toBe(1n);

      const json = toJsonString(
        ui.WorkerLinkDiagnosticsSchema,
        create(ui.WorkerLinkDiagnosticsSchema, { measures: values }),
      );

      expect(json).not.toContain(directory);
      expect(json).not.toContain("private-invalid-option");
    } finally {
      workerDiagnostics.stop();
    }
  });

  test("delivery churn and unanswered interactions stay bounded and human waits count once", () => {
    let clock = 0;

    const diagnostics = new WorkerDiagnostics(
      () => clock,
      () => clock,
    );

    diagnostics.enabled = true;

    for (let index = 0; index < 300; index++) {
      diagnostics.sent(`thread-${index}`, 1n, true);
      diagnostics.turns.begin(`thread-${index}`, "turn", "codex");
    }

    expect(diagnostics.turns.active.size).toBe(64);
    expect(diagnostics.measurements.dropped).toBe(280);
    diagnostics.turns.human("thread-0", "turn");
    diagnostics.turns.human("thread-0", "turn");
    clock = 250;
    diagnostics.turns.humanDone("thread-0", "turn");
    clock = 500;
    diagnostics.turns.humanDone("thread-0", "turn");
    diagnostics.turns.humanDone("thread-0", "turn");
    diagnostics.turns.finish("thread-0", "turn");
    const rows = diagnostics.measurements.drain(clock);
    expect(rows.find((row) => row.metricId === harnessMetric("codex", "human"))?.histogram?.sum).toBe(500);
    expect(rows.find((row) => row.metricId === 105)?.events).toBe(300n);
    expect(diagnostics.measurements.used).toBeLessThanOrEqual(diagnostics.measurements.limit);
    diagnostics.stop();
    expect(diagnostics.turns.active.size).toBe(0);
  });
});
