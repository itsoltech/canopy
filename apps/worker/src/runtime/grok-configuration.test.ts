import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  DeviceLogin,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ProviderProfileKind,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  WorkerConfigSchema,
  type InteractionResponse,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { ManagedRuntime } from "effect";
import { AgentTools } from "../agent-tools/index.ts";
import { applyWorkerConfig } from "../config/remote.ts";
import { HeadTracker } from "../git/heads.ts";
import { Journal } from "../journal/index.ts";
import { HostContext } from "./host-context.ts";
import { HostState } from "./host-state.ts";

const temporary = tempDirs();

test("Grok settings reconcile at the turn boundary and resume the durable session", async () => {
  const root = realpathSync(temporary("canopy-grok-settings-"));
  const executable = resolve(import.meta.dir, "../providers/grok/fixtures/agent.ts");
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));
  const state = new HostState({ runtime, dataDir: root, clientVersion: "test" });
  state.agentTools = new AgentTools({ dataDir: root, send: () => {}, progress: () => {} });
  state.heads = new HeadTracker(() => {});
  const ctx = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });

  const spec = create(ThreadSpecSchema, {
    threadId: "grok-thread",
    provider: Provider.GROK,
    cwd: root,
    permissionMode: PermissionMode.ASK,
  });

  const apply = async (version: bigint, settingsText: string, settingsOverrideText = "") => {
    const applied = applyWorkerConfig(
      create(WorkerConfigSchema, {
        version,
        grok: { enabled: true, executablePath: executable, deviceLogin: DeviceLogin.NONE },
        profiles: [
          {
            id: "native",
            providers: [Provider.GROK],
            kind: ProviderProfileKind.NATIVE,
            settingsText,
            settingsOverrideText,
          },
        ],
      }),
      { which: () => executable, version: () => "1.0.70", realDirectory: (path) => path },
    );

    if (!applied.applied) throw new Error("Expected Grok configuration to apply");
    state.config = applied.config;
    await ctx.ops.reconcileRuntimes();
  };

  const applyThreshold = (version: bigint, threshold: number) =>
    apply(
      version,
      `[session]\nauto_compact_threshold_percent = ${threshold}\n[models]\nmax_completion_tokens = 5000\ndefault_reasoning_effort = "high"`,
    );

  const instanceDir = join(root, "grok", "native");

  const processHome = () => {
    const homes = readdirSync(instanceDir).filter((name) => name.startsWith("process-"));
    expect(homes).toHaveLength(1);

    return join(instanceDir, homes[0]!);
  };

  const configAt = (home: string) => Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8"));
  const waiting = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<InteractionResponse>();
  ctx.ops.interact = async () => {
    waiting.resolve();

    return answer.promise;
  };

  let first: Promise<void> | undefined;

  try {
    await apply(
      1n,
      '[models]\ndefault_reasoning_effort = "high"\nmax_completion_tokens = 4000\n[session]\nauto_compact_threshold_percent = 65',
      "[models]\nmax_completion_tokens = 5000\n[session]",
    );
    const original = state.acp.get("grok/native");
    const catalog = await ctx.ops.runAcp("grok/native", (threads) => threads.listModels("native"));
    expect(catalog.models[0]?.defaultEffort).toBe("high");
    spec.providerThreadId = await ctx.ops.runAcp("grok/native", (threads) => threads.create(spec));
    const oldHome = processHome();
    expect(configAt(oldHome)).toMatchObject({
      models: { default_reasoning_effort: "high", max_completion_tokens: 5000 },
      session: { auto_compact_threshold_percent: 65 },
    });
    await applyThreshold(2n, 65);
    expect(state.acp.get("grok/native")).toBe(original);

    first = ctx.ops.runAcp("grok/native", (threads) =>
      threads.startTurn(spec, "first", create(UserInputSchema, { text: "PERMISSION" })),
    );
    await Promise.race([
      waiting.promise,
      first.then(() => {
        throw new Error("The first turn ended before requesting permission");
      }),
    ]);
    await applyThreshold(3n, 0);
    expect(state.staleRuntimes.has("grok/native")).toBe(true);
    expect(state.acp.get("grok/native")).toBe(original);
    expect(original?.runtime.running(spec.threadId)).toBe(true);
    expect(configAt(oldHome)).toMatchObject({ session: { auto_compact_threshold_percent: 65 } });
    answer.resolve(create(InteractionResponseSchema, { allow: true }));
    await first;

    await ctx.ops.runAcp("grok/native", (threads) =>
      threads.startTurn(spec, "second", create(UserInputSchema, { text: "Continue the conversation" }), {
        model: "",
        effort: "",
        habitContext: "SANDBOX",
      }),
    );
    expect(state.acp.get("grok/native")).not.toBe(original);
    expect(existsSync(oldHome)).toBe(false);
    expect(configAt(processHome())).toMatchObject({ session: { auto_compact_threshold_percent: 0 } });
    const events = await runtime.runPromise(Journal.use((journal) => journal.pending(new Map())));
    expect(events.flatMap((event) => (event.body.case === "turnFinished" ? [event.body.value] : []))).toMatchObject([
      { outcome: TurnOutcome.COMPLETED, providerTurnRef: spec.providerThreadId },
      { outcome: TurnOutcome.COMPLETED, providerTurnRef: spec.providerThreadId },
    ]);

    const messages = events.flatMap((event) =>
      event.turnId === "second" && event.body.case === "itemCompleted" ? [event.body.value.item?.content] : [],
    );

    expect(messages.find((item) => item?.case === "userMessage")).toMatchObject({
      value: { text: "Continue the conversation" },
    });
    expect(messages.find((item) => item?.case === "agentMessage")).toMatchObject({
      value: { text: expect.stringMatching(/^SANDBOX=/) },
    });
  } finally {
    answer.resolve(create(InteractionResponseSchema, { cancelled: true }));
    await first?.catch(() => undefined);
    state.closing = true;
    await state.runtimeReconcile;
    await state.acp.get("grok/native")?.runtime.close();
    state.heads.close();
    await runtime.dispose();
  }
});
