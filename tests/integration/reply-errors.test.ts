import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bots, Provider, ProviderProfileKind, TurnEndSource, TurnOutcome } from "@canopy/contracts";
import { toJsonString } from "@bufbuild/protobuf";
import { dockerAvailable } from "@canopy/db/testing";
import { Match, Schema } from "effect";
import { ProviderFailure } from "@canopy/domain";
import { directModel } from "../../apps/gateway/src/bots/model.ts";
import { botsSuite } from "./support/bots.ts";
import { eventually, failure, watchUntil } from "./support/gateway.ts";

const Request = Schema.Struct({
  model: Schema.String,
  stream: Schema.Boolean,
  max_tokens: Schema.optionalKey(Schema.Number),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.NullOr(Schema.String) })),
});

describe.skipIf(!dockerAvailable)("actionable errors across gateway APIs", () => {
  const { suite, add, send, settled } = botsSuite();
  let endpoint: ReturnType<typeof Bun.serve>;
  let requests = 0;

  const faults = new Map([
    ["auth", { status: 401, code: "auth_required" }],
    ["model", { status: 404, code: "model_unavailable" }],
    ["usage", { status: 429, code: "usage_limit" }],
  ]);

  beforeAll(async () => {
    endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
        const body = Schema.decodeUnknownSync(Request)(await request.json());
        expect(body.model).toBe("grok-4.7");
        expect(body.stream).toBe(false);
        requests++;
        const prompt = body.messages.findLast((message) => message.role === "user")?.content ?? "";
        const fault = faults.get(prompt);

        if (fault)
          return Response.json({ error: { message: "never expose echoed-key-or-prompt" } }, { status: fault.status });

        if (prompt === "length" || body.max_tokens === 4096)
          return Response.json({ choices: [{ finish_reason: "length", message: { content: null } }] });

        if (prompt === "malformed") return Response.json({ unexpected: true });

        if (prompt === "truncated") return new Response('{"choices":[');

        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "GROK_BOT_OK" } }] });
      },
    });
    suite.model = directModel((input) =>
      suite.current.bots.run((store) => store.provider(suite.gw.userId, input.configuration)),
    );

    const native = (await suite.gw.api.listProviderInstances({})).instances.find(
      (instance) => instance.harness === Provider.GROK && instance.id === "native",
    )!;

    await suite.gw.api.saveProviderInstance({
      harness: Provider.GROK,
      id: "native",
      kind: ProviderProfileKind.CLIPROXYAPI,
      label: "Grok proxy",
      baseUrl: endpoint.url.href,
      apiKey: "fixture-only-key",
      expectedRevision: native.revision,
    });
    await suite.gw.api.setInstanceModels({ harness: Provider.GROK, id: "native", models: { custom: ["grok-4.7"] } });
  }, 30_000);

  afterAll(async () => {
    await endpoint?.stop(true);
  });

  const grokBot = (name: string) =>
    add(name, { provider: Provider.GROK, providerInstance: "native", model: "grok-4.7" });

  test("Grok bot with native id and Proxy connection uses the gateway API without a reasoning-starving cap", async () => {
    const bot = await grokBot("Grok API");
    await send(bot.id, "hello");
    expect((await settled(bot.id)).messages.at(-1)).toMatchObject({ text: "GROK_BOT_OK", failed: false });
    expect(requests).toBeGreaterThan(0);
    const instances = (await suite.gw.api.getBotProviderInstances({ botId: bot.id })).instances;
    expect(instances.find((instance) => instance.harness === Provider.GROK && instance.id === "native")?.kind).toBe(
      ProviderProfileKind.CLIPROXYAPI,
    );
    await suite.gw.api.saveProviderInstance({
      harness: Provider.GROK,
      id: "proxy-looking",
      label: "Device login",
      create: true,
      kind: ProviderProfileKind.NATIVE,
    });
    await suite.gw.api.setInstanceModels({
      harness: Provider.GROK,
      id: "proxy-looking",
      models: { custom: ["grok-4.7"] },
    });
    expect(
      await failure(
        add("Device cannot be bot", { provider: Provider.GROK, providerInstance: "proxy-looking", model: "grok-4.7" }),
      ),
    ).toContain("gateway-accessible");
  });

  test("bot failure classes survive storage, gRPC snapshots, list previews and retry without leaking provider bodies", async () => {
    const bot = await grokBot("Failure classes");

    for (const [prompt, code] of [
      ["auth", "auth_required"],
      ["model", "model_unavailable"],
      ["usage", "usage_limit"],
      ["length", "stream_cut_off"],
      ["truncated", "stream_cut_off"],
      ["malformed", "internal"],
    ] as const) {
      await send(bot.id, prompt);
      const saved = await settled(bot.id);
      expect(saved.messages.at(-1)).toMatchObject({ failed: true, errorCode: code, errorSource: "provider" });
      const controller = new AbortController();

      try {
        for await (const snapshot of suite.gw.api.watchBotConversation(
          { botId: bot.id },
          { signal: controller.signal },
        )) {
          expect(snapshot.messages.at(-1)?.errorCode).toBe(code);
          expect(toJsonString(bots.BotConversationSchema, snapshot)).not.toContain("echoed-key-or-prompt");
          break;
        }
      } finally {
        controller.abort();
      }

      expect((await suite.gw.api.listBots({})).bots.find((item) => item.id === bot.id)?.lastMessage?.errorCode).toBe(
        code,
      );
    }

    // A pluggable model can also report an executable failure through the same boundary.
    suite.model = async () => {
      throw new ProviderFailure("process_exit", "Model process exited (7)", "harness");
    };

    await send(bot.id, "process exit");
    expect((await settled(bot.id)).messages.at(-1)).toMatchObject({
      errorCode: "process_exit",
      errorSource: "harness",
    });
    suite.model = directModel(async () => {
      throw new Error("private internal diagnostics");
    });
    await send(bot.id, "internal error");
    expect((await settled(bot.id)).messages.at(-1)).toMatchObject({
      errorCode: "internal",
      text: "Bot could not finish this turn",
    });
    suite.model = directModel((input) =>
      suite.current.bots.run((store) => store.provider(suite.gw.userId, input.configuration)),
    );
    await suite.gw.api.retryBot({ botId: bot.id });
    expect((await settled(bot.id)).messages.at(-1)).toMatchObject({
      text: "GROK_BOT_OK",
      failed: false,
      errorCode: "",
    });
  }, 20_000);

  test("native harness error codes reach thread snapshots with stable actionable classes", async () => {
    const thread = (
      await suite.gw.api.createThread({
        projectId: suite.projectId,
        workspaceId: suite.workspaceId,
        provider: Provider.CODEX,
        model: "gpt-6.1-sol",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    await eventually(
      () => suite.gw.api.getThread({ threadId: thread.id }),
      (response) => response.thread?.status === "idle",
    );
    suite.currentWorker.holdTurns = true;

    for (const [errorCode, reason, errorClass] of [
      ["httpConnectionFailed:401", "Login expired", "auth_required"],
      ["model_not_found", "The requested model does not exist", "model_unavailable"],
      ["usageLimitReached", "Usage limit reached", "usage_limit"],
      ["process_exit", "Claude process exited (7)", "process_exit"],
      ["error_during_execution", "CLI executable not found", "cli_missing"],
      ["PROVIDER_UNAVAILABLE", "Claude Code is not installed on this computer", "cli_missing"],
      ["PROVIDER_UNAVAILABLE", "custom-wrapper not found or not runnable", "cli_missing"],
      ["PROVIDER_UNAVAILABLE", "no Codex login on this device", "auth_required"],
      ["httpConnectionFailed", "Connection timed out", "network"],
      ["httpConnectionFailed", "Request failed", "network"],
      ["responseStreamDisconnected", "Request failed", "stream_cut_off"],
      ["contextWindowExceeded", "Request failed", "configuration"],
    ] as const) {
      const turn = (
        await suite.gw.api.sendMessage({ threadId: thread.id, text: "hello", clientRequestId: crypto.randomUUID() })
      ).turn!;

      await eventually(() => Promise.resolve(suite.currentWorker.started.has(turn.id)), Boolean);
      suite.currentWorker.emit(thread.id, turn.id, {
        case: "turnFinished",
        value: { outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, reason, errorCode },
      });

      const updates = await watchUntil(suite.gw.api, thread.id, (list) =>
        list.some((update) =>
          update.change.case === "turn"
            ? update.change.value.id === turn.id && update.change.value.status === "failed"
            : update.change.case === "snapshot" &&
              update.change.value.turns.some((item) => item.id === turn.id && item.status === "failed"),
        ),
      );

      const finished = updates
        .flatMap((update) =>
          Match.value(update.change).pipe(
            Match.when({ case: "turn" }, (change) => [change.value]),
            Match.when({ case: "snapshot" }, (change) => change.value.turns),
            Match.orElse(() => []),
          ),
        )
        .findLast((item) => item.id === turn.id);

      expect(finished).toMatchObject({ errorCode, errorClass, errorSource: "harness" });
    }
  }, 15_000);

  test("provider changes emit invalidation even without workers, including connection switches and model choices", async () => {
    const stream = suite.gw.api
      .watchOverview({ includeSnapshot: true }, { signal: AbortSignal.timeout(10000) })
      [Symbol.asyncIterator]();

    await stream.next();

    try {
      const native = (await suite.gw.api.listProviderInstances({})).instances.find(
        (instance) => instance.harness === Provider.CLAUDE && instance.id === "native",
      )!;

      const changes = [
        () =>
          suite.gw.api.saveProviderInstance({
            harness: Provider.CLAUDE,
            id: "workerless",
            label: "Workerless device",
            create: true,
            kind: ProviderProfileKind.NATIVE,
            allWorkers: false,
          }),
        () =>
          suite.gw.api.saveProviderInstance({
            harness: Provider.CLAUDE,
            id: "native",
            kind: ProviderProfileKind.CLIPROXYAPI,
            baseUrl: endpoint.url.href,
            expectedRevision: native.revision,
          }),
        () =>
          suite.gw.api.setInstanceModels({
            harness: Provider.CLAUDE,
            id: "workerless",
            models: { custom: ["custom-model"] },
          }),
        () => suite.gw.api.deleteProviderInstance({ harness: Provider.CLAUDE, id: "workerless", expectedRevision: 1n }),
      ];

      for (const change of changes) {
        await change();

        for (;;) {
          const update = await stream.next();

          if (update.done) throw new Error("Overview ended before invalidation");

          if (update.value.change.case === "providerInstancesChanged") break;
        }
      }

      const worker = (await suite.gw.api.getOverview({})).workers.find((item) => item.id === suite.gw.workerId)!;
      expect(
        worker.providerInstances.find((instance) => instance.harness === Provider.CLAUDE && instance.id === "native")
          ?.kind,
      ).toBe(ProviderProfileKind.CLIPROXYAPI);
    } finally {
      await stream.return?.();
    }
  }, 15_000);
});
