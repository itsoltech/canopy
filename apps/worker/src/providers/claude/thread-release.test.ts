import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs, waitForProcessStopped } from "@canopy/testing";
import { Layer, ManagedRuntime } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { ClaudeThreads } from "./threads.ts";
import { probeRecords, inputRecords } from "../../../../../tests/integration/fixtures/instance-probe.ts";

const temporary = tempDirs();

const until = async (check: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }

  throw new Error("Fixture did not reach the expected state");
};

for (const phase of ["active", "background", "admission"])
  test(`Claude unload stops only its thread during ${phase} and resumes the same conversation`, async () => {
    const root = temporary("canopy-claude-release-");
    const home = join(root, "home");
    mkdirSync(home);
    const trace = join(root, "trace.jsonl");
    const events: ThreadEvent[] = [];
    const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["claude"] }])[0]!.resolved!;

    const runtime = ManagedRuntime.make(
      ClaudeThreads.layer({
        home,
        executable: resolve(import.meta.dir, "../../../../../tests/integration/fixtures/instance-claude.ts"),
        baseEnv: { PATH: process.env["PATH"], INSTANCE_TRACE: trace },
        nativeTools: { nativeSubagents: false, nativeScheduling: false },
        profile: () => profile,
        publish: (event) => events.push(event),
        interact: async () => create(InteractionResponseSchema),
        callTool: async () => create(AgentToolResultSchema),
      }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
    );

    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    try {
      const threads = await runtime.runPromise(ClaudeThreads);
      const a = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root, enableAgentBus: true });
      const b = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root, enableAgentBus: true });
      a.providerThreadId = await runtime.runPromise(threads.create(a));
      b.providerThreadId = await runtime.runPromise(threads.create(b));
      await runtime.runPromise(
        threads.startTurn(b, crypto.randomUUID(), create(UserInputSchema, { text: "HOLD:sibling" })),
      );
      const warm = crypto.randomUUID();
      await runtime.runPromise(
        threads.startTurn(a, warm, create(UserInputSchema, { text: "Remember the conversation" })),
      );
      await until(() => events.some((event) => event.turnId === warm && event.body.case === "turnFinished"));
      const turnId = crypto.randomUUID();
      const text = phase === "background" ? "CONNECTOR_BACKGROUND" : "HOLD:archived";

      const starting = runtime.runPromise(
        threads.startTurn(a, turnId, create(UserInputSchema, { text }), {
          model: "",
          effort: "",
          ...(phase === "admission" && {
            connectorsReady: () => {
              ready.resolve();

              return release.promise;
            },
          }),
        }),
      );

      if (phase === "admission") await ready.promise;
      else await starting;

      if (phase === "background")
        await until(() => events.some((event) => event.turnId === turnId && event.body.case === "turnFinished"));
      await until(() => probeRecords(trace).some((record) => record.session === a.providerThreadId));
      const pid = probeRecords(trace).findLast((record) => record.session === a.providerThreadId)!.pid;
      const siblingPid = probeRecords(trace).find((record) => record.session === b.providerThreadId)!.pid;
      const unloading = runtime.runPromise(threads.unload(a.threadId));
      await Bun.sleep(10);
      release.resolve();
      await starting;
      await unloading;
      await waitForProcessStopped(pid);
      expect(threads.running(a.threadId)).toBe(false);
      expect(threads.running(b.threadId)).toBe(true);
      expect(threads.backgroundTasks().has(a.threadId)).toBe(false);
      expect(() => process.kill(siblingPid, 0)).not.toThrow();

      if (phase === "admission")
        expect(inputRecords(trace).flatMap((record) => record.parts.map((part) => part.text))).not.toContain(text);
      await runtime.runPromise(threads.unload(a.threadId));
      const next = crypto.randomUUID();
      await runtime.runPromise(
        threads.startTurn(a, next, create(UserInputSchema, { text: "Continue the conversation" })),
      );
      await until(() => events.some((event) => event.turnId === next && event.body.case === "turnFinished"));

      const latest = probeRecords(trace).findLast(
        (record) => record.session === a.providerThreadId && record.event === "turn",
      );

      expect(latest?.session).toBe(a.providerThreadId);
      expect(latest?.pid).not.toBe(pid);
      expect(threads.backgroundTasks().has(a.threadId)).toBe(false);
    } finally {
      release.resolve();
      await runtime.dispose();
    }
  }, 15_000);
