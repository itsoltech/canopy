import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ManagedRuntime } from "effect";
import { EventAckSchema, PermissionMode, Provider, ThreadSpecSchema, UserInputSchema } from "@canopy/contracts";
import { Journal } from "../../apps/worker/src/journal/journal.ts";
import { journalHello, resendPending, applyAck, type GatewayLink } from "../../apps/worker/src/gateway-link/index.ts";
import { workerDiagnostics } from "../../apps/worker/src/diagnostics/worker.ts";
import { GrokThreads } from "../../apps/worker/src/providers/grok/threads.ts";
import { freshGit, git } from "../../apps/worker/src/git/git.ts";

/** Real SQLite journal + deterministic ACP + git, identical work in both members. No inference or probes. */
export class DiagnosticsWorkerWorkload {
  readonly directory = mkdtempSync(join(tmpdir(), "canopy-diagnostics-worker-"));
  readonly enabled =
    ["4", "5"].includes(process.env["CANOPY_BENCH_STAGE"] ?? "") || process.env["CANOPY_BENCH_DIAGNOSTICS"] === "1";
  readonly runtime = ManagedRuntime.make(Journal.layer(join(this.directory, "journal.db"), this.enabled));
  readonly threads = new GrokThreads({
    dataDir: this.directory,
    executable: resolve(import.meta.dir, "../../apps/worker/src/providers/grok/fixtures/agent.ts"),
    linkDeviceLogin: false,
    profile: () => ({
      kind: "native" as const,
      id: "native",
      providers: ["grok" as const],
      env: {},
      runtime: { ownLogin: true },
    }),
    record: async (thread, event) => {
      const value = await this.runtime.runPromise(Journal.use((journal) => journal.append(thread, event)));

      try {
        this.link?.send({ case: "threadEvent", value });
      } catch {
        /* Durable backlog is replayed on reconnect. */
      }

      return value;
    },
    interact: async () => {
      throw new Error("Unexpected benchmark interaction");
    },
    callTool: async () => {
      throw new Error("Unexpected benchmark tool");
    },
  });
  link: GatewayLink | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;
  turns = 0;
  failed = 0;

  async start() {
    const result = Bun.spawnSync(["git", "init", "-q", this.directory], { stdout: "ignore", stderr: "ignore" });

    if (result.exitCode) throw new Error("Benchmark git fixture failed");
    const journal = await this.runtime.runPromise(Journal);

    if (this.enabled) workerDiagnostics.start(this.directory, journal.statistics);
  }

  hello() {
    return this.runtime.runPromise(journalHello());
  }
  async connected(link: GatewayLink) {
    this.link = link;
    workerDiagnostics.record(110, 1);
    workerDiagnostics.record(111, 1);
    await this.runtime.runPromise(resendPending(link));
  }
  ack(threadId: string, ackSeq: bigint) {
    return this.runtime.runPromise(applyAck(create(EventAckSchema, { threadId, ackSeq })));
  }

  begin(phase: string) {
    clearInterval(this.#timer);

    if (phase === "idle") return;
    this.#timer = setInterval(() => {
      if (this.#pending) return;
      this.#pending = this.#turn()
        .catch(() => {
          this.failed++;
        })
        .finally(() => {
          this.#pending = undefined;
        });
    }, 1000);
  }

  async #turn() {
    const threadId = process.env["CANOPY_BENCH_WORKER_THREAD"],
      turnId = process.env["CANOPY_BENCH_WORKER_TURN"];

    if (!threadId || !turnId) throw new Error("Worker workload needs a seeded thread and turn");

    const spec = create(ThreadSpecSchema, {
      threadId,
      cwd: this.directory,
      provider: Provider.GROK,
      providerProfileId: "native",
      model: "fake-grok",
      permissionMode: PermissionMode.FULL_ACCESS,
    });

    workerDiagnostics.turns.queue(threadId, turnId, "grok");
    await this.threads.startTurn(spec, turnId, create(UserInputSchema, { text: "SANDBOX" }));
    await freshGit(() => git(this.directory, ["status", "--porcelain"]));
    this.turns++;
  }

  async end() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending;
  }
  async close() {
    await this.end();
    await this.threads.close();
    workerDiagnostics.stop();
    await this.runtime.dispose();
    rmSync(this.directory, { recursive: true, force: true });
    console.error(JSON.stringify({ phase: "worker_workload", turns: this.turns, failed: this.failed }));

    if (this.failed) throw new Error("Benchmark worker workload failed");
  }
}
