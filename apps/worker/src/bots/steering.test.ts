import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ManagedRuntime } from "effect";
import { tempDirs } from "@canopy/testing";
import {
  CommandSchema,
  Provider,
  ProviderProfileKind,
  RunBotTurnSchema,
  SteerBotTurnSchema,
  WorkerConfigSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { applyWorkerConfig } from "../config/remote.ts";
import { Journal } from "../journal/index.ts";
import { HostState } from "../runtime/host-state.ts";
import { HostContext } from "../runtime/host-context.ts";
import { runtimeKeys, stopRuntime } from "../runtime/instance-runtimes.ts";
import { HeadTracker } from "../git/heads.ts";
import { botSession } from "./session.ts";

const tempDir = tempDirs();

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();

    if (matches(value)) return value;
    await Bun.sleep(10);
  }

  throw new Error("Timed out waiting for native harness");
}

function fixture(provider: Provider) {
  const root = tempDir("canopy-bot-steering-");
  const dataDir = join(root, "data");
  const trace = join(root, "trace.jsonl");
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));

  const state = new HostState({
    runtime,
    dataDir,
    clientVersion: "test",
    deviceHomes: {
      claude: join(root, "device-claude"),
      codex: join(root, "device-codex"),
      grok: join(root, "device-grok"),
    },
  });

  state.heads = new HeadTracker(() => {});
  const ctx = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });

  const executable = resolve(
    import.meta.dir,
    provider === Provider.GROK
      ? "../../../../tests/integration/fixtures/instance-grok.ts"
      : "fixtures/steer-harness.ts",
  );

  const configured = applyWorkerConfig(
    create(WorkerConfigSchema, {
      version: 1n,
      claude: { enabled: true, executablePath: executable },
      codex: { enabled: true, executablePath: executable },
      grok: { enabled: true, executablePath: executable },
      profiles: [
        {
          id: "fixture",
          providers: [provider],
          kind: ProviderProfileKind.NATIVE,
          env: [
            { name: "STEER_TRACE", value: trace },
            { name: "INSTANCE_TRACE", value: trace },
          ],
        },
      ],
    }),
    { which: () => executable, version: () => "1.0.0", realDirectory: (path) => path, login: () => "fixture" },
    {
      dataDir,
      claude: join(root, "device-claude"),
      codex: join(root, "device-codex"),
      grok: join(root, "device-grok"),
    },
  );

  if (!configured.applied) throw new Error("Invalid fixture configuration");
  state.config = configured.config;

  const input = create(RunBotTurnSchema, {
    botId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    provider,
    profileId: "fixture",
    model: "fixture",
    conversationId: crypto.randomUUID(),
    historyJson: "[]",
    input: "WAIT",
  });

  const events = () => runtime.runPromise(Journal.use((j) => j.pending(new Map())));

  const steer = (text: string, inputId = crypto.randomUUID(), botId = input.botId, turnId = input.turnId) =>
    ctx.ops.execute(
      create(CommandSchema, {
        commandId: crypto.randomUUID(),
        kind: { case: "steerBotTurn", value: create(SteerBotTurnSchema, { botId, turnId, inputId, text }) },
      }),
    );

  return {
    root,
    dataDir,
    runtime,
    ctx,
    input,
    events,
    steer,
    records: () => (existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : []),
    close: async () => {
      // Final events schedule reconciliation, which can start ordinary provider runtimes too.
      // Follow WorkerHost.close: prevent new starts, drain pending starts, then stop their handles.
      state.closing = true;
      await ctx.ops.closeBots();
      await state.runtimeReconcile;

      for (const key of runtimeKeys(ctx).keys()) await stopRuntime(ctx, key);
      state.heads.close();
      state.secrets.close();
      await runtime.dispose();
    },
  };
}

const hasNotice = (events: readonly ThreadEvent[], code: string, inputId: string) =>
  events.some(
    (event) =>
      event.body.case === "notice" &&
      event.body.value.code === code &&
      event.body.value.dataJson === JSON.stringify({ input_id: inputId }),
  );

for (const provider of [Provider.CLAUDE, Provider.CODEX]) {
  test(`${Provider[provider]} bot steering confirms consumption, rejects foreign targets and drops the completion race`, async () => {
    const f = fixture(provider);
    const applied = crypto.randomUUID();
    const dropped = crypto.randomUUID();
    const foreignEcho = crypto.randomUUID();

    try {
      await f.ctx.ops.runBotTurn(f.input, crypto.randomUUID());
      await eventually(
        async () => f.records(),
        (records) => records.length > 0,
      );
      expect((await f.steer("FOREIGN", crypto.randomUUID(), crypto.randomUUID())).dataJson).toContain("unsupported");
      expect((await f.steer("FOREIGN", crypto.randomUUID(), f.input.botId, crypto.randomUUID())).dataJson).toContain(
        "unsupported",
      );
      expect((await f.steer("APPLY", applied)).dataJson).toContain("queued");
      const consumed = await eventually(f.events, (events) => hasNotice(events, "bot_steer_applied", applied));
      expect(
        consumed.filter((e) => e.body.case === "notice" && e.body.value.code === "bot_steer_applied"),
      ).toHaveLength(1);
      expect((await f.steer("APPLY", applied)).dataJson).toContain("delivered");

      if (provider === Provider.CODEX) await f.steer("FOREIGN_ECHO", foreignEcho);
      expect((await f.steer("DROP", dropped)).dataJson).toContain("queued");
      const finished = await eventually(f.events, (events) => events.some((e) => e.body.case === "turnFinished"));
      expect(hasNotice(finished, "bot_steer_dropped", dropped)).toBe(true);
      expect(hasNotice(finished, "bot_steer_applied", dropped)).toBe(false);
      expect(hasNotice(finished, "bot_steer_applied", foreignEcho)).toBe(false);
      expect(
        finished.findIndex((e) => e.body.case === "notice" && e.body.value.code === "bot_steer_dropped"),
      ).toBeLessThan(finished.findIndex((e) => e.body.case === "turnFinished"));
      expect(finished.every((event) => event.threadId === f.input.botId && event.turnId === f.input.turnId)).toBe(true);
      expect(f.records().filter((line) => line.includes(applied))).toHaveLength(1);
      expect(f.records().join("\n")).not.toContain('"text":"FOREIGN"');
      expect(botSession(f.input, { dataDir: f.dataDir, sourceHome: "", linkLogin: false }).id).toBe("");
      expect((await f.steer("LATE")).dataJson).toContain("unsupported");

      if (provider === Provider.CODEX) {
        const usages = finished.flatMap((event) =>
          event.body.case === "usageUpdated" && event.body.value.usage?.scope ? [event.body.value.usage] : [],
        );

        expect(usages.at(-1)).toMatchObject({
          inputTokens: 2n,
          outputTokens: 2n,
          reportedCostUsd: 246,
          requestedServiceTier: "default",
        });
        expect(usages.map((usage) => usage.reportedCostUsd)).toEqual([123, 246]);
      }
    } finally {
      await f.close();
    }
  }, 10_000);

  test(`${Provider[provider]} unknown native write is never replayed after harness failure`, async () => {
    const f = fixture(provider);
    const inputId = crypto.randomUUID();

    try {
      await f.ctx.ops.runBotTurn(f.input, crypto.randomUUID());
      await eventually(
        async () => f.records(),
        (records) => records.length > 0,
      );
      await f.steer("CRASH", inputId);
      const events = await eventually(f.events, (records) => records.some((e) => e.body.case === "turnFinished"));
      expect(hasNotice(events, "bot_steer_dropped", inputId)).toBe(true);
      expect(hasNotice(events, "bot_steer_applied", inputId)).toBe(false);
      expect(f.records().filter((line) => line.includes(inputId))).toHaveLength(1);
      const saved = events.map((e) => e.eventId);
      expect((await f.events()).map((e) => e.eventId)).toEqual(saved);
      expect(botSession(f.input, { dataDir: f.dataDir, sourceHome: "", linkLogin: false }).id).toBe("");

      if (provider === Provider.CODEX) {
        const usage = events
          .flatMap((event) =>
            event.body.case === "usageUpdated" && event.body.value.usage?.scope ? [event.body.value.usage] : [],
          )
          .at(-1);

        expect(usage).toMatchObject({ inputTokens: 1n, reportedCostUsd: 123, requestedServiceTier: "default" });
      }
    } finally {
      await f.close();
    }
  }, 10_000);
}

test("Grok keeps the active turn running and returns unsupported without sending native input", async () => {
  const f = fixture(Provider.GROK);
  f.input.input = "HOLD:unsupported";

  try {
    await f.ctx.ops.runBotTurn(f.input, crypto.randomUUID());
    await eventually(
      async () => f.records(),
      (records) => records.some((line) => line.includes('"event":"turn"')),
    );
    expect((await f.steer("DO_NOT_SEND")).dataJson).toContain("unsupported");
    expect((await f.events()).some((event) => event.body.case === "turnFinished")).toBe(false);
    writeFileSync(join(f.root, "release-unsupported"), "release");
    await eventually(f.events, (events) => events.some((event) => event.body.case === "turnFinished"));
    expect(f.records().join("\n")).not.toContain("DO_NOT_SEND");
  } finally {
    await f.close();
  }
}, 10_000);

test("Claude delivery-failure UUID echoes do not prove consumption", async () => {
  const f = fixture(Provider.CLAUDE);
  const inputId = crypto.randomUUID();

  try {
    await f.ctx.ops.runBotTurn(f.input, crypto.randomUUID());
    await eventually(
      async () => f.records(),
      (records) => records.length > 0,
    );
    expect((await f.steer("REJECT", inputId)).dataJson).toContain("queued");
    const events = await eventually(f.events, (records) => records.some((event) => event.body.case === "turnFinished"));
    expect(hasNotice(events, "bot_steer_applied", inputId)).toBe(false);
    expect(hasNotice(events, "bot_steer_dropped", inputId)).toBe(true);
  } finally {
    await f.close();
  }
}, 10_000);
