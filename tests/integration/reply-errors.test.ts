import { beforeAll, describe, expect, test } from "bun:test";
import { bots, Provider, ProviderProfileKind, TurnEndSource, TurnOutcome } from "@canopy/contracts";
import { toJsonString } from "@bufbuild/protobuf";
import { dockerAvailable } from "@canopy/db/testing";
import { Match } from "effect";
import { ProviderFailure } from "@canopy/domain";
import { botsSuite } from "./support/bots.ts";
import { eventually, watchUntil } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("actionable errors across gateway APIs", () => {
  const { suite, add, send, settled } = botsSuite();
  beforeAll(async () => {
    await suite.gw.api.setInstanceModels({ harness: Provider.GROK, id: "native", models: { custom: ["grok-4.7"] } });
  }, 30_000);

  const grokBot = (name: string) =>
    add(name, { provider: Provider.GROK, providerInstance: "native", model: "grok-4.7" });

  test("bot harness failure classes survive storage, gRPC snapshots, list previews and retry", async () => {
    const bot = await grokBot("Failure classes");

    for (const [prompt, code] of [
      ["auth", "auth_required"],
      ["model", "model_unavailable"],
      ["usage", "usage_limit"],
      ["length", "stream_cut_off"],
      ["truncated", "stream_cut_off"],
      ["malformed", "internal"],
    ] as const) {
      suite.model = async () => {
        throw new ProviderFailure(
          code,
          "Bot harness failed at https://private.invalid/api?token=fixture-redaction-token; Bearer fixture-redaction-key",
          "harness",
        );
      };

      await send(bot.id, prompt);
      const saved = await settled(bot.id);
      expect(saved.messages.at(-1)).toMatchObject({ failed: true, errorCode: code, errorSource: "harness" });
      expect(saved.messages.at(-1)?.text).toContain("[redacted]");
      const controller = new AbortController();

      try {
        for await (const snapshot of suite.gw.api.watchBotConversation(
          { botId: bot.id },
          { signal: controller.signal },
        )) {
          expect(snapshot.messages.at(-1)?.errorCode).toBe(code);

          for (const privateValue of ["private.invalid", "fixture-redaction-token", "fixture-redaction-key"])
            expect(toJsonString(bots.BotConversationSchema, snapshot)).not.toContain(privateValue);

          break;
        }
      } finally {
        controller.abort();
      }

      const preview = (await suite.gw.api.listBots({})).bots.find((item) => item.id === bot.id)?.lastMessage;
      expect(preview).toMatchObject({ errorCode: code, errorSource: "harness", text: saved.messages.at(-1)?.text });
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
    suite.model = async () => {
      throw new Error("private internal diagnostics");
    };

    await send(bot.id, "internal error");
    expect((await settled(bot.id)).messages.at(-1)).toMatchObject({
      errorCode: "internal",
      text: "Bot could not finish this turn",
    });
    suite.model = async () => ({ text: "GROK_BOT_OK", calls: [] });
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
            baseUrl: "https://proxy.invalid",
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
