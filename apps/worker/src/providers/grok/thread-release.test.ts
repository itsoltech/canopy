import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  ThreadEventSchema,
  ThreadSpecSchema,
  UserInputSchema,
} from "@canopy/contracts";
import { tempDirs, waitForProcessStopped } from "@canopy/testing";
import { Schema } from "effect";
import { GrokThreads } from "./threads.ts";

const temporary = tempDirs();
const Trace = Schema.Struct({ pid: Schema.Number, home: Schema.String });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }

  throw new Error("Fixture did not reach the expected state");
};

for (const phase of ["active", "initialization", "admission"])
  test(`Grok unload disposes its thread during ${phase}, retaining other sessions and history`, async () => {
    const root = temporary("canopy-grok-release-");
    const trace = join(root, "trace.jsonl");
    let block = false;

    const threads = new GrokThreads({
      dataDir: root,
      executable: join(import.meta.dir, "fixtures/thread-release.ts"),
      linkDeviceLogin: false,
      profile: () => ({
        kind: "native",
        id: "native",
        providers: ["grok"],
        runtime: {},
        env: { RELEASE_TRACE: trace, ...(block && { RELEASE_MARKER: join(root, "release") }) },
      }),
      record: async () => create(ThreadEventSchema),
      interact: async () => create(InteractionResponseSchema),
      callTool: async () => create(AgentToolResultSchema),
    });

    const records = () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => Schema.decodeSync(Schema.fromJsonString(Trace))(line));

    const a = create(ThreadSpecSchema, { threadId: "archived", cwd: root });
    const b = create(ThreadSpecSchema, { threadId: "sibling", cwd: root });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    try {
      b.providerThreadId = await threads.create(b);

      if (phase !== "initialization") a.providerThreadId = await threads.create(a);
      block = phase === "initialization";

      const started =
        phase === "initialization"
          ? threads.create(a).then(
              () => undefined,
              () => undefined,
            )
          : threads.startTurn(a, "first", create(UserInputSchema, { text: "HANG" }), {
              model: "",
              effort: "",
              ...(phase === "admission" && {
                connectorsReady: () => {
                  ready.resolve();

                  return release.promise;
                },
              }),
            });

      if (phase === "initialization") await until(() => existsSync(trace) && records().length === 2);
      else if (phase === "admission") await ready.promise;
      else await until(() => threads.running(a.threadId));
      const original = records()[1]!;
      await threads.unload(a.threadId);
      release.resolve();
      await started;
      await waitForProcessStopped(original.pid);
      expect(existsSync(original.home)).toBe(false);
      expect(threads.running(a.threadId)).toBe(false);
      expect(existsSync(records()[0]!.home)).toBe(true);
      await threads.startTurn(b, "sibling-next", create(UserInputSchema, { text: "Hello" }));
      await threads.unload(a.threadId);

      if (phase !== "initialization") {
        await threads.startTurn(a, "next", create(UserInputSchema, { text: "Continue the conversation" }));
        expect(existsSync(join(original.home, "sessions", `${a.providerThreadId}.json`))).toBe(false);
        expect(records().at(-1)?.pid).not.toBe(original.pid);
      }
    } finally {
      release.resolve();
      await threads.close();
    }
  });
